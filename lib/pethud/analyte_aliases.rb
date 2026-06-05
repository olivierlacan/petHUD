# frozen_string_literal: true

require "json"

module PetHUD
  # Section-scoped analyte-name aliases (mirrors web/lib/aliases.js).
  #
  # Some IDEXX report layouts wrap a long analyte name across two lines, which
  # the parser emits as truncated/fragmented names (e.g. "Blood /" + "Hemoglobin"
  # for "Blood / Hemoglobin"). The rules in config/analyte_aliases.json map each
  # confirmed-identical variant to its canonical name WITHIN a section, so the
  # analyte catalog and trend series unify instead of showing duplicate/empty
  # cards. Applied at the catalog layer (upsert_analyte) only — the raw
  # measurement name is stored unchanged, so per-report exports are untouched.
  module AnalyteAliases
    DEFAULT_PATH = File.join(PetHUD::ROOT.to_s, "config", "analyte_aliases.json")

    class << self
      # canonical name for (section, name); returns name unchanged if no alias.
      def canonical(section, name, path: DEFAULT_PATH)
        table(path).fetch([section, name], name)
      end

      def table(path = DEFAULT_PATH)
        @tables ||= {}
        @tables[path] ||= load_table(path)
      end

      def reset!
        @tables = {}
      end

      private

      def load_table(path)
        return {} unless File.exist?(path)

        data = JSON.parse(File.read(path))
        Array(data["aliases"]).each_with_object({}) do |a, h|
          next unless a["section"] && a["from"] && a["to"]

          h[[a["section"], a["from"]]] = a["to"]
        end
      rescue StandardError
        {}
      end
    end
  end
end
