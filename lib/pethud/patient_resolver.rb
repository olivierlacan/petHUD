# frozen_string_literal: true

require "json"

module PetHUD
  # Maps a report's identity (pet name / owner / external id) to a canonical
  # patient, so the same physical animal recorded under different owners or
  # clinic systems (e.g. "IRIS REED" and "IRIS PARK") lands in one profile.
  #
  # Rules live in config/patients.json. A report matches a configured patient
  # when ANY of these is true:
  #   - its patient external id is listed in `external_ids`
  #   - its uppercased pet name is listed in `names`
  #   - its uppercased owner is listed in `owners`
  # Reports matching nothing get an auto-created patient keyed by external id
  # (falling back to name+owner), so nothing is ever silently merged or lost.
  class PatientResolver
    Patient = Struct.new(:slug, :name, :species, :notes, keyword_init: true)

    def initialize(config_path)
      @config_path = config_path.to_s
      @rules = load_rules
      @auto = {} # cache of auto-created patients this run
    end

    def load_rules
      return [] unless File.exist?(@config_path)

      data = JSON.parse(File.read(@config_path))
      Array(data["patients"]).map do |p|
        match = p["match"] || {}
        {
          slug: p["slug"],
          name: p["name"],
          species: p["species"],
          notes: p["notes"],
          names: Array(match["names"]).map { |s| s.to_s.upcase.strip },
          owners: Array(match["owners"]).map { |s| s.to_s.upcase.strip },
          external_ids: Array(match["external_ids"]).map { |s| s.to_s.strip }
        }
      end
    end

    # Returns a Patient for the given report meta hash.
    def resolve(meta)
      name = meta[:pet_name].to_s.upcase.strip
      owner = meta[:pet_owner].to_s.upcase.strip
      ext = meta[:patient_external_id].to_s.strip

      rule = @rules.find do |r|
        (!ext.empty? && r[:external_ids].include?(ext)) ||
          (!name.empty? && r[:names].include?(name)) ||
          (!owner.empty? && r[:owners].include?(owner))
      end

      if rule
        Patient.new(slug: rule[:slug], name: rule[:name],
                    species: rule[:species] || meta[:species], notes: rule[:notes])
      else
        auto_patient(meta, name, owner, ext)
      end
    end

    private

    def auto_patient(meta, name, owner, ext)
      key = ext.empty? ? "#{name}-#{owner}" : ext
      @auto[key] ||= begin
        slug = slugify(meta[:pet_name] || meta[:pet_owner] || key)
        slug = "#{slug}-#{key}" if @auto.values.any? { |p| p.slug == slug }
        Patient.new(
          slug: slug,
          name: title_case(meta[:pet_name] || meta[:pet_owner] || "Unknown"),
          species: meta[:species],
          notes: "Auto-created (no alias rule matched)."
        )
      end
    end

    def slugify(str)
      str.to_s.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-|-\z/, "")
    end

    def title_case(str)
      str.to_s.split(/\s+/).map(&:capitalize).join(" ")
    end
  end
end
