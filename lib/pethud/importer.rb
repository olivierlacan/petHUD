# frozen_string_literal: true

module PetHUD
  # Orchestrates a single PDF through parse -> patient resolution -> SQLite,
  # then writes that report's structured JSON export. Holds open one Database
  # and PatientResolver so batch imports reuse them.
  class Importer
    Result = Struct.new(:status, :report_id, :patient, :parsed, :source, keyword_init: true)

    def initialize(db: nil, resolver: nil, exporter: nil)
      @db = db || Database.new(PetHUD.db_path)
      @resolver = resolver || PatientResolver.new(PetHUD.config_path)
      @exporter = exporter || Exporter.new(@db)
    end

    attr_reader :db, :resolver

    # Imports one PDF. Returns a Result with status :imported, :replaced or
    # :skipped (already present, unless force:).
    def import(path, force: false)
      path = path.to_s
      raise ArgumentError, "no such file: #{path}" unless File.file?(path)

      parsed = ReportParser.parse(path)
      patient = @resolver.resolve(parsed[:meta])
      already = @db.report_exists?(parsed[:file_sha256])

      report_id = @db.import_report(parsed, patient, force: force)
      if report_id.nil?
        return Result.new(status: :skipped, patient: patient, parsed: parsed, source: path)
      end

      @exporter.write_report_json(report_id)
      status = already ? :replaced : :imported
      Result.new(status: status, report_id: report_id, patient: patient, parsed: parsed, source: path)
    end

    # Import many paths; yields each Result for progress reporting.
    def import_all(paths, force: false)
      paths.map do |p|
        result = import(p, force: force)
        yield result if block_given?
        result
      end
    end

    def close = @db.close
  end
end
