# frozen_string_literal: true

require "optparse"
require_relative "../pethud"

module PetHUD
  # Command-line entry point. Subcommands:
  #   import <pdf...>   parse PDFs into SQLite + JSON, refresh viewer data
  #   reimport          re-run import on every PDF already in samples/ + inbox/
  #   export            regenerate all JSON exports + web/data.js from the DB
  #   list              list patients / reports / analytes
  #   serve             start the local viewer + drag-and-drop import server
  #   reset             drop the database (and generated exports)
  class CLI
    def self.run(argv) = new.run(argv)

    def run(argv)
      cmd = argv.shift
      case cmd
      when "import"   then cmd_import(argv)
      when "reimport" then cmd_reimport(argv)
      when "export"   then cmd_export(argv)
      when "list"     then cmd_list(argv)
      when "knowledge" then cmd_knowledge(argv)
      when "serve"    then cmd_serve(argv)
      when "reset"    then cmd_reset(argv)
      when nil, "-h", "--help", "help" then usage
      else
        warn "unknown command: #{cmd}\n\n"
        usage
        exit 1
      end
    end

    def usage
      puts <<~TXT
        pethud — IDEXX pet bloodwork analyzer

        Usage:
          bin/pethud import <pdf|dir> [more...] [--force]   Import PDF report(s)
          bin/pethud reimport [--force]                     Re-import samples/ + inbox/
          bin/pethud export                                 Rebuild JSON + web/data.js
          bin/pethud list [patients|reports|analytes]       Inspect the corpus
          bin/pethud knowledge                              Audit the medical-context config
          bin/pethud serve [--port N] [--open]              Run the local viewer
          bin/pethud reset [--force]                        Delete the database

        Env: PETHUD_DB overrides the database path.
      TXT
    end

    # --- import -----------------------------------------------------------

    def cmd_import(argv)
      force = argv.delete("--force")
      paths = expand_pdfs(argv)
      abort "no PDF files given" if paths.empty?
      ensure_pdftotext!

      importer = Importer.new
      counts = Hash.new(0)
      importer.import_all(paths, force: force) do |res|
        counts[res.status] += 1
        report_result(res)
      end
      refresh_web_data(importer.db)
      importer.close
      puts "\n#{counts[:imported]} imported, #{counts[:replaced]} replaced, #{counts[:skipped]} skipped (use --force to re-import)."
    end

    def cmd_reimport(argv)
      force = argv.include?("--force") ? ["--force"] : []
      paths = Dir[File.join(ROOT, "samples", "*.pdf")] + Dir[File.join(PetHUD.inbox_dir, "*.pdf")]
      cmd_import(paths.uniq + force)
    end

    # --- export -----------------------------------------------------------

    def cmd_export(_argv)
      db = Database.new(PetHUD.db_path)
      exporter = Exporter.new(db)
      jsons = exporter.export_all_reports
      data = exporter.write_web_data(generated_at: Time.now.utc.iso8601)
      db.close
      puts "Wrote #{jsons.size} report JSON files to #{PetHUD.exports_dir}"
      puts "Wrote viewer data to #{data}"
    end

    # --- list -------------------------------------------------------------

    def cmd_list(argv)
      what = argv.shift || "patients"
      db = Database.new(PetHUD.db_path).db
      case what
      when "patients"
        db.execute(<<~SQL).each do |p|
          SELECT pt.name, pt.slug, COUNT(r.id) reports,
                 MIN(r.result_date) lo, MAX(r.result_date) hi
          FROM patients pt LEFT JOIN reports r ON r.patient_id = pt.id
          GROUP BY pt.id ORDER BY pt.name
        SQL
          puts format("%-16s %-10s %3s reports  %s -> %s", p["name"], p["slug"], p["reports"], p["lo"], p["hi"])
        end
      when "reports"
        db.execute("SELECT result_date, pet_name, pet_owner, lab_id, source_file FROM reports ORDER BY result_date").each do |r|
          puts format("%-12s %-12s owner=%-10s lab=%-12s %s", r["result_date"], r["pet_name"], r["pet_owner"], r["lab_id"], r["source_file"])
        end
      when "analytes"
        db.execute("SELECT section, name, canonical_unit FROM analytes ORDER BY section, name").each do |a|
          puts format("%-14s %-28s %s", a["section"], a["name"], a["canonical_unit"])
        end
      else
        abort "list: expected patients|reports|analytes"
      end
    end

    # --- knowledge --------------------------------------------------------

    # Audit the medical-context config: validate every analyte key and citation
    # id against the imported data, and summarize coverage.
    def cmd_knowledge(_argv)
      db = Database.new(PetHUD.db_path).db
      known = db.execute("SELECT section, name FROM analytes").map { |a| Knowledge.key_for(a["section"], a["name"]) }
      kb = Knowledge.new
      warnings = kb.validate(known)

      puts "Knowledge base: #{kb.sources.size} sources, #{kb.analytes.size} analytes with context, " \
           "#{kb.relationships.size} relationships, #{kb.conditions.size} conditions."
      covered = kb.analytes.keys.count { |k| known.include?(k) }
      puts "Analyte context covers #{covered}/#{known.size} imported analytes."
      if warnings.empty?
        puts "Validation: OK — every analyte key matches and every citation resolves."
      else
        puts "Validation: #{warnings.size} warning(s):"
        warnings.each { |w| puts "  - #{w}" }
        exit 1
      end
    end

    # --- serve ------------------------------------------------------------

    def cmd_serve(argv)
      port = 8787
      open = false
      OptionParser.new do |o|
        o.on("--port N", Integer) { |n| port = n }
        o.on("--open") { open = true }
      end.parse!(argv)

      ensure_pdftotext!
      require_relative "server"
      Server.new(port: port).start(open: open)
    end

    # --- reset ------------------------------------------------------------

    def cmd_reset(argv)
      unless argv.include?("--force")
        abort "This deletes #{PetHUD.db_path} and generated exports. Re-run with --force."
      end
      File.delete(PetHUD.db_path) if File.exist?(PetHUD.db_path)
      Dir[File.join(PetHUD.exports_dir, "*.json")].each { |f| File.delete(f) }
      data = File.join(PetHUD.web_dir, "data.js")
      File.delete(data) if File.exist?(data)
      puts "Reset complete."
    end

    # --- helpers ----------------------------------------------------------

    def expand_pdfs(args)
      args.flat_map do |a|
        if File.directory?(a)
          Dir[File.join(a, "*.pdf")]
        else
          [a]
        end
      end.select { |p| p.downcase.end_with?(".pdf") }.uniq
    end

    def refresh_web_data(db)
      Exporter.new(db).write_web_data(generated_at: Time.now.utc.iso8601)
    end

    def report_result(res)
      icon = { imported: "+", replaced: "~", skipped: "=" }[res.status]
      name = res.parsed[:meta][:pet_name]
      date = res.parsed[:meta][:result_date]
      nmeas = res.parsed[:sections].sum { |s| s[:measurements].size }
      puts format("  %s %-42s -> %-8s %s  (%d values)", icon, File.basename(res.source), res.patient.slug, date, nmeas)
    end

    def ensure_pdftotext!
      return if PdfExtractor.available?

      abort <<~MSG
        Could not find `pdftotext` (poppler). Install it:
          macOS:  brew install poppler
          Debian: apt-get install poppler-utils
        Or set PDFTOTEXT to its path.
      MSG
    end
  end
end
