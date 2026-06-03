# frozen_string_literal: true

require "yaml"
require "set"

module PetHUD
  # Loads and validates the medical-context knowledge base from
  # config/knowledge/*.yml and shapes it for the viewer.
  #
  # Design goals (the knowledge is medical, so this stays boringly transparent):
  #   - All content lives in flat, citation-bearing YAML — this class adds no
  #     medical logic, it only loads, validates, and reshapes.
  #   - Validation catches the two ways the data could quietly lie: an analyte
  #     key that doesn't match any real metric, or a citation id with no source.
  #   - Analyte keys are the human-readable "Section / Name" used in the YAML.
  class Knowledge
    attr_reader :sources, :analytes, :relationships, :conditions, :disclaimer

    def self.key_for(section, name) = "#{section} / #{name}"

    def initialize(dir = File.join(PetHUD::ROOT, "config", "knowledge"))
      @dir = dir.to_s
      load!
    end

    def load!
      @sources       = load_yaml("sources.yml").fetch("sources", {})
      @analytes      = load_yaml("analytes.yml").fetch("analytes", {})
      @relationships = load_yaml("relationships.yml").fetch("relationships", [])
      conditions_doc = load_yaml("conditions.yml")
      @disclaimer    = conditions_doc["disclaimer"]
      @conditions    = conditions_doc.fetch("conditions", {})
    end

    def load_yaml(file)
      path = File.join(@dir, file)
      return {} unless File.exist?(path)

      YAML.safe_load_file(path) || {}
    end

    # Returns an array of human-readable warning strings. `known_keys` is the set
    # of "Section / Name" strings that actually exist in the imported data.
    def validate(known_keys)
      warnings = []
      known = known_keys.to_a.to_set
      source_ids = @sources.keys.to_set

      check_sources = lambda do |ids, where|
        Array(ids).each do |id|
          warnings << "#{where}: unknown source id '#{id}'" unless source_ids.include?(id)
        end
      end

      @analytes.each do |key, info|
        warnings << "analytes.yml: '#{key}' matches no imported analyte" unless known.include?(key)
        check_sources.call(info["sources"], "analytes.yml['#{key}']")
      end

      @relationships.each_with_index do |edge, i|
        Array(edge["between"]).each do |key|
          warnings << "relationships.yml[#{i}]: '#{key}' matches no imported analyte" unless known.include?(key)
        end
        check_sources.call(edge["source"], "relationships.yml[#{i}]")
      end

      @conditions.each do |slug, cond|
        check_sources.call(cond["sources"], "conditions.yml['#{slug}']")
        Array(cond["metrics"]).each do |m|
          key = m["analyte"]
          warnings << "conditions.yml['#{slug}']: metric '#{key}' matches no imported analyte" unless known.include?(key)
        end
        if (st = cond["staging"])
          check_sources.call(st["source"], "conditions.yml['#{slug}'].staging")
        end
      end

      warnings
    end

    # The structure merged into web/data.js (and per-report JSON if desired).
    # Analyte/condition keys stay as "Section / Name" so the viewer can look up
    # context directly from an analyte's section+name.
    def payload
      {
        disclaimer: @disclaimer,
        sources: @sources,
        analytes: @analytes,
        relationships: @relationships,
        conditions: conditions_payload
      }
    end

    def conditions_payload
      @conditions.map do |slug, cond|
        { "slug" => slug }.merge(cond)
      end
    end
  end
end
