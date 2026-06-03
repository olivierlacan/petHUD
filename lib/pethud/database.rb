# frozen_string_literal: true

require "sqlite3"
require "fileutils"

module PetHUD
  # Owns the SQLite schema and all writes. The schema is normalized around a
  # long-format `measurements` table (one row per analyte per report) which is
  # exactly the shape the trend viewer wants: filter by patient + analyte,
  # order by report date, read the series.
  class Database
    SCHEMA = <<~SQL
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS patients (
        id         INTEGER PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        species    TEXT,
        notes      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Every distinct (name, owner, external id) we've seen mapped to a
      -- patient. Makes the aliasing auditable.
      CREATE TABLE IF NOT EXISTS patient_identities (
        id          INTEGER PRIMARY KEY,
        patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        pet_name    TEXT,
        owner       TEXT,
        external_id TEXT,
        UNIQUE (patient_id, pet_name, owner, external_id)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id              INTEGER PRIMARY KEY,
        patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        file_sha256     TEXT NOT NULL UNIQUE,
        source_file     TEXT NOT NULL,
        pet_name        TEXT,
        pet_owner       TEXT,
        species         TEXT,
        breed           TEXT,
        gender          TEXT,
        age_text        TEXT,
        age_years       REAL,
        external_id     TEXT,
        lab_id          TEXT,
        order_id        TEXT,
        account_number  TEXT,
        attending_vet   TEXT,
        clinic_name     TEXT,
        idexx_services  TEXT,
        collection_date TEXT,
        received_date   TEXT,
        result_date     TEXT,
        imported_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Catalog of distinct analytes (a test within a section). Gives every
      -- chartable measurement a stable id/slug for the viewer.
      CREATE TABLE IF NOT EXISTS analytes (
        id             INTEGER PRIMARY KEY,
        section        TEXT NOT NULL,
        name           TEXT NOT NULL,
        slug           TEXT NOT NULL UNIQUE,
        canonical_unit TEXT,
        UNIQUE (section, name)
      );

      CREATE TABLE IF NOT EXISTS measurements (
        id          INTEGER PRIMARY KEY,
        report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        analyte_id  INTEGER NOT NULL REFERENCES analytes(id) ON DELETE CASCADE,
        section     TEXT NOT NULL,
        name        TEXT NOT NULL,
        result_text TEXT,
        value       REAL,
        qualifier   TEXT,
        unit        TEXT,
        ref_low     REAL,
        ref_high    REAL,
        ref_text    TEXT,
        flag        TEXT,
        is_numeric  INTEGER NOT NULL DEFAULT 0,
        position    INTEGER
      );

      CREATE TABLE IF NOT EXISTS section_notes (
        id        INTEGER PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        section   TEXT NOT NULL,
        name      TEXT,
        text      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_meas_patient_analyte ON measurements (patient_id, analyte_id);
      CREATE INDEX IF NOT EXISTS idx_meas_report          ON measurements (report_id);
      CREATE INDEX IF NOT EXISTS idx_reports_patient      ON reports (patient_id);
    SQL

    attr_reader :db, :path

    def initialize(path)
      @path = path.to_s
      FileUtils.mkdir_p(File.dirname(@path))
      @db = SQLite3::Database.new(@path)
      @db.busy_timeout = 5000
      @db.results_as_hash = true
      @db.execute_batch(SCHEMA)
    end

    def close = @db.close

    # True if a report with this file hash is already imported.
    def report_exists?(sha)
      !@db.get_first_value("SELECT 1 FROM reports WHERE file_sha256 = ?", sha).nil?
    end

    # Import one parsed report under the given resolved patient. Idempotent:
    # re-importing the same file (or force:) replaces the prior rows.
    # Returns the report id, or nil if skipped.
    def import_report(parsed, patient, force: false)
      sha = parsed[:file_sha256]
      meta = parsed[:meta]

      @db.transaction do
        existing = @db.get_first_value("SELECT id FROM reports WHERE file_sha256 = ?", sha)
        if existing
          return nil unless force
          @db.execute("DELETE FROM reports WHERE id = ?", existing) # cascades
        end

        patient_id = upsert_patient(patient)
        record_identity(patient_id, meta)
        report_id = insert_report(patient_id, sha, parsed[:source_file], meta)
        insert_measurements(report_id, patient_id, parsed[:sections])
        insert_notes(report_id, parsed[:sections])
        report_id
      end
    end

    def upsert_patient(patient)
      @db.execute(
        "INSERT INTO patients (slug, name, species, notes) VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           species = COALESCE(excluded.species, patients.species),
           notes = COALESCE(excluded.notes, patients.notes)",
        [patient.slug, patient.name, patient.species, patient.notes]
      )
      @db.get_first_value("SELECT id FROM patients WHERE slug = ?", patient.slug)
    end

    def record_identity(patient_id, meta)
      @db.execute(
        "INSERT OR IGNORE INTO patient_identities (patient_id, pet_name, owner, external_id)
         VALUES (?, ?, ?, ?)",
        [patient_id, meta[:pet_name], meta[:pet_owner], meta[:patient_external_id]]
      )
    end

    def insert_report(patient_id, sha, source_file, meta)
      @db.execute(
        "INSERT INTO reports
          (patient_id, file_sha256, source_file, pet_name, pet_owner, species, breed,
           gender, age_text, age_years, external_id, lab_id, order_id, account_number,
           attending_vet, clinic_name, idexx_services, collection_date, received_date, result_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [patient_id, sha, source_file, meta[:pet_name], meta[:pet_owner], meta[:species],
         meta[:breed], meta[:gender], meta[:age_text], meta[:age_years],
         meta[:patient_external_id], meta[:lab_id], meta[:order_id], meta[:account_number],
         meta[:attending_vet], meta.dig(:clinic, :name), meta[:idexx_services],
         meta[:collection_date], meta[:received_date], meta[:result_date]]
      )
      @db.last_insert_row_id
    end

    def insert_measurements(report_id, patient_id, sections)
      sections.each do |section|
        section[:measurements].each_with_index do |m, idx|
          analyte_id = upsert_analyte(section[:name], m[:name], m[:unit])
          @db.execute(
            "INSERT INTO measurements
              (report_id, patient_id, analyte_id, section, name, result_text, value,
               qualifier, unit, ref_low, ref_high, ref_text, flag, is_numeric, position)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [report_id, patient_id, analyte_id, section[:name], m[:name], m[:result_text],
             m[:value], m[:qualifier], m[:unit], m[:ref_low], m[:ref_high], m[:ref_text],
             m[:flag], m[:numeric] ? 1 : 0, idx]
          )
        end
      end
    end

    def insert_notes(report_id, sections)
      sections.each do |section|
        Array(section[:notes]).each do |note|
          @db.execute(
            "INSERT INTO section_notes (report_id, section, name, text) VALUES (?,?,?,?)",
            [report_id, section[:name], note[:name], note[:text]]
          )
        end
      end
    end

    def upsert_analyte(section, name, unit)
      existing = @db.get_first_row("SELECT id, canonical_unit FROM analytes WHERE section = ? AND name = ?", [section, name])
      if existing
        if existing["canonical_unit"].nil? && unit
          @db.execute("UPDATE analytes SET canonical_unit = ? WHERE id = ?", [unit, existing["id"]])
        end
        return existing["id"]
      end

      slug = unique_slug(analyte_slug(section, name))
      @db.execute(
        "INSERT INTO analytes (section, name, slug, canonical_unit) VALUES (?,?,?,?)",
        [section, name, slug, unit]
      )
      @db.last_insert_row_id
    end

    # "% Neutrophils" and "Neutrophils" slugify alike; keep slugs human-readable
    # but unique by suffixing a counter on collision.
    def unique_slug(base)
      return base unless @db.get_first_value("SELECT 1 FROM analytes WHERE slug = ?", base)

      n = 2
      n += 1 while @db.get_first_value("SELECT 1 FROM analytes WHERE slug = ?", "#{base}-#{n}")
      "#{base}-#{n}"
    end

    def analyte_slug(section, name)
      slug = "#{section}-#{name}".downcase.gsub("%", " pct ")
      slug.gsub(/[^a-z0-9]+/, "-").gsub(/\A-|-\z/, "")
    end
  end
end
