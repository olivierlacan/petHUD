# frozen_string_literal: true

require "pathname"

# IDEXX pet bloodwork analyzer: parse VetConnect PLUS PDF reports into SQLite
# and JSON, for a zero-dependency trend viewer.
module PetHUD
  ROOT = Pathname.new(File.expand_path("..", __dir__))

  module_function

  def db_path        = ENV.fetch("PETHUD_DB", (ROOT / "db" / "pethud.sqlite3").to_s)
  def config_path    = (ROOT / "config" / "patients.json").to_s
  def exports_dir    = (ROOT / "exports" / "reports").to_s
  def web_dir        = (ROOT / "web").to_s
  def inbox_dir      = (ROOT / "inbox").to_s
end

require_relative "pethud/pdf_extractor"
require_relative "pethud/report_parser"
require_relative "pethud/patient_resolver"
require_relative "pethud/database"
require_relative "pethud/knowledge"
require_relative "pethud/importer"
require_relative "pethud/exporter"
