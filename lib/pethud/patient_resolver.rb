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
    #
    # A report matches a configured patient when its external id is listed, OR
    # the pet's given name matches (as the leading word of pet_name, which on
    # IDEXX reports reads "<NAME> <OWNER SURNAME>"). Owner is deliberately NOT a
    # match key on its own — one household has multiple pets, so matching by
    # owner would merge different animals (e.g. Iris and P'tit Loup, both REED).
    def resolve(meta)
      name = meta[:pet_name].to_s.upcase.strip
      ext = meta[:patient_external_id].to_s.strip

      rule = @rules.find do |r|
        (!ext.empty? && r[:external_ids].include?(ext)) ||
          (!name.empty? && r[:names].any? { |n| name_matches?(name, n) })
      end

      if rule
        Patient.new(slug: rule[:slug], name: rule[:name],
                    species: rule[:species] || meta[:species], notes: rule[:notes])
      else
        auto_patient(meta, name, ext)
      end
    end

    # pet_name equals the configured name, or starts with it as a whole word.
    def name_matches?(pet_name, configured)
      pet_name == configured || pet_name.start_with?("#{configured} ")
    end

    private

    def auto_patient(meta, name, ext)
      owner = meta[:pet_owner].to_s.upcase.strip
      key = ext.empty? ? "#{name}-#{owner}" : ext
      @auto[key] ||= begin
        given = given_name(meta[:pet_name], meta[:pet_owner])
        slug = slugify(given || meta[:pet_owner] || key)
        slug = "#{slug}-#{key}" if @auto.values.any? { |p| p.slug == slug }
        Patient.new(
          slug: slug,
          name: title_case(given || meta[:pet_owner] || "Unknown"),
          species: meta[:species],
          notes: "Auto-created (no alias rule matched). Edit config/patients.json to alias."
        )
      end
    end

    # The pet's given name = pet_name with the trailing owner surname removed.
    # IDEXX appends the owner's surname (the last word of the owner field):
    # "P'TIT LOUP PARK" + owner "MAYA PARK" -> "P'TIT LOUP".
    def given_name(pet_name, owner)
      return nil if pet_name.nil? || pet_name.strip.empty?

      n = pet_name.strip
      surname = owner.to_s.strip.split(/\s+/).last
      n = n[0...-(surname.length + 1)].strip if surname && !surname.empty? && n.upcase.end_with?(" #{surname.upcase}")
      n.empty? ? pet_name.strip : n
    end

    def slugify(str)
      str.to_s.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-|-\z/, "")
    end

    def title_case(str)
      str.to_s.split(/\s+/).map(&:capitalize).join(" ")
    end
  end
end
