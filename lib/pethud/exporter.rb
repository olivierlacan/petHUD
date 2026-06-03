# frozen_string_literal: true

require "json"
require "fileutils"

module PetHUD
  # Reads from SQLite (single source of truth) and emits:
  #   - exports/reports/<file>.json : one structured document per report
  #   - web/data.js                 : window.PETHUD_DATA for the static viewer
  class Exporter
    def initialize(db)
      @db = db.is_a?(Database) ? db.db : db
    end

    # --- Per-report JSON --------------------------------------------------

    def write_report_json(report_id, dir: PetHUD.exports_dir)
      FileUtils.mkdir_p(dir)
      doc = report_document(report_id)
      base = File.basename(doc[:report][:source_file], ".*")
      path = File.join(dir, "#{base}.json")
      File.write(path, JSON.pretty_generate(doc) + "\n")
      path
    end

    def export_all_reports(dir: PetHUD.exports_dir)
      ids = @db.execute("SELECT id FROM reports ORDER BY result_date").map { |r| r["id"] }
      ids.map { |id| write_report_json(id, dir: dir) }
    end

    def report_document(report_id)
      r = @db.get_first_row("SELECT * FROM reports WHERE id = ?", report_id)
      raise "no report #{report_id}" unless r

      patient = @db.get_first_row("SELECT slug, name FROM patients WHERE id = ?", r["patient_id"])
      measurements = @db.execute(
        "SELECT * FROM measurements WHERE report_id = ? ORDER BY section, position", report_id
      )
      notes = @db.execute(
        "SELECT section, name, text FROM section_notes WHERE report_id = ?", report_id
      )

      sections = {}
      measurements.each do |m|
        s = (sections[m["section"]] ||= { name: m["section"], measurements: [], notes: [] })
        s[:measurements] << {
          name: m["name"], result_text: m["result_text"], value: m["value"],
          qualifier: m["qualifier"], unit: m["unit"], ref_low: m["ref_low"],
          ref_high: m["ref_high"], ref_text: m["ref_text"], flag: m["flag"],
          numeric: m["is_numeric"] == 1
        }
      end
      notes.each do |n|
        s = (sections[n["section"]] ||= { name: n["section"], measurements: [], notes: [] })
        s[:notes] << { name: n["name"], text: n["text"] }
      end

      {
        report: {
          id: r["id"], source_file: r["source_file"],
          patient: { slug: patient["slug"], name: patient["name"] },
          pet_name: r["pet_name"], pet_owner: r["pet_owner"], species: r["species"],
          breed: r["breed"], gender: r["gender"], age_text: r["age_text"],
          age_years: r["age_years"], external_id: r["external_id"], lab_id: r["lab_id"],
          order_id: r["order_id"], account_number: r["account_number"],
          attending_vet: r["attending_vet"], clinic_name: r["clinic_name"],
          idexx_services: r["idexx_services"], collection_date: r["collection_date"],
          received_date: r["received_date"], result_date: r["result_date"],
          imported_at: r["imported_at"]
        },
        sections: sections.values
      }
    end

    # --- Viewer data.js ---------------------------------------------------

    def write_web_data(path: File.join(PetHUD.web_dir, "data.js"), generated_at: nil)
      FileUtils.mkdir_p(File.dirname(path))
      payload = build_payload(generated_at: generated_at)
      json = JSON.generate(payload)
      File.write(path, "window.PETHUD_DATA = #{json};\n")
      path
    end

    def build_payload(generated_at: nil)
      analytes = analytes_payload
      {
        generated_at: generated_at,
        patients: patients_payload,
        reports: reports_payload,
        analytes: analytes,
        series: series_payload,
        knowledge: knowledge_payload(analytes)
      }
    end

    # Loads the medical-context knowledge base, validates it against the analytes
    # actually present, prints any warnings, and returns its payload (or nil if
    # the config is absent).
    def knowledge_payload(analytes)
      kb = Knowledge.new
      known_keys = analytes.map { |a| Knowledge.key_for(a[:section], a[:name]) }
      warnings = kb.validate(known_keys)
      unless warnings.empty?
        warn "knowledge: #{warnings.size} validation warning(s):"
        warnings.each { |w| warn "  - #{w}" }
      end
      kb.payload
    rescue => e
      warn "knowledge: skipped (#{e.class}: #{e.message})"
      nil
    end

    def patients_payload
      @db.execute("SELECT * FROM patients ORDER BY name").map do |p|
        ids = @db.execute(
          "SELECT DISTINCT pet_name, owner, external_id FROM patient_identities WHERE patient_id = ?",
          p["id"]
        ).map { |i| { pet_name: i["pet_name"], owner: i["owner"], external_id: i["external_id"] } }
        range = @db.get_first_row(
          "SELECT MIN(result_date) lo, MAX(result_date) hi, COUNT(*) n FROM reports WHERE patient_id = ?",
          p["id"]
        )
        # Age from the most recent report that recorded one (for life-stage).
        age = @db.get_first_row(
          "SELECT age_years, age_text FROM reports WHERE patient_id = ? AND age_years IS NOT NULL " \
          "ORDER BY result_date DESC, id DESC LIMIT 1", p["id"]
        ) || {}
        {
          id: p["id"], slug: p["slug"], name: p["name"], species: p["species"],
          notes: p["notes"], identities: ids,
          report_count: range["n"], date_range: [range["lo"], range["hi"]],
          age_years: age["age_years"], age_text: age["age_text"]
        }
      end
    end

    def reports_payload
      @db.execute("SELECT * FROM reports ORDER BY result_date, id").map do |r|
        {
          id: r["id"], patient_id: r["patient_id"], date: r["result_date"],
          collection_date: r["collection_date"], source_file: r["source_file"],
          lab_id: r["lab_id"], clinic_name: r["clinic_name"],
          attending_vet: r["attending_vet"], idexx_services: r["idexx_services"],
          age_text: r["age_text"], age_years: r["age_years"]
        }
      end
    end

    # Analytes that actually appear, with per-patient presence and a numeric flag.
    def analytes_payload
      rows = @db.execute(<<~SQL)
        SELECT a.id, a.slug, a.section, a.name, a.canonical_unit AS unit,
               MAX(m.is_numeric) AS numeric,
               COUNT(*) AS n
        FROM analytes a
        JOIN measurements m ON m.analyte_id = a.id
        GROUP BY a.id
        ORDER BY a.section, MIN(m.position)
      SQL
      rows.map do |r|
        patient_ids = @db.execute(
          "SELECT DISTINCT patient_id FROM measurements WHERE analyte_id = ?", r["id"]
        ).map { |x| x["patient_id"] }
        {
          id: r["id"], slug: r["slug"], section: r["section"], name: r["name"],
          unit: r["unit"], numeric: r["numeric"] == 1, count: r["n"],
          patient_ids: patient_ids
        }
      end
    end

    # series[patient_id][analyte_id] = [ {date, value, ...} ] ordered by date.
    def series_payload
      rows = @db.execute(<<~SQL)
        SELECT m.patient_id, m.analyte_id, r.result_date AS date, r.id AS report_id,
               m.value, m.unit, m.ref_low, m.ref_high, m.flag, m.qualifier,
               m.result_text, m.is_numeric
        FROM measurements m
        JOIN reports r ON r.id = m.report_id
        ORDER BY m.patient_id, m.analyte_id, r.result_date, r.id
      SQL
      series = Hash.new { |h, k| h[k] = Hash.new { |h2, k2| h2[k2] = [] } }
      rows.each do |m|
        series[m["patient_id"]][m["analyte_id"]] << {
          date: m["date"], report_id: m["report_id"], value: m["value"],
          unit: m["unit"], ref_low: m["ref_low"], ref_high: m["ref_high"],
          flag: m["flag"], qualifier: m["qualifier"], result_text: m["result_text"],
          numeric: m["is_numeric"] == 1
        }
      end
      series
    end
  end
end
