# frozen_string_literal: true

# Run with: ruby -Ilib -Itest test/test_knowledge.rb
require "minitest/autorun"
require "pethud"

# Internal-consistency checks on the medical-context knowledge base. These guard
# the two ways the data could quietly mislead: a citation with no source, or an
# analyte key that doesn't line up across files. (Validation against the live
# imported analytes happens in the exporter / `bin/pethud knowledge`.)
class TestKnowledge < Minitest::Test
  def setup
    @kb = PetHUD::Knowledge.new
  end

  def analyte_keys_in_yaml
    @kb.analytes.keys
  end

  def test_loads_all_files
    refute_empty @kb.sources
    refute_empty @kb.analytes
    refute_empty @kb.relationships
    refute_empty @kb.conditions
    refute_nil @kb.disclaimer
  end

  def test_every_cited_source_exists
    ids = @kb.sources.keys.to_set
    missing = []

    @kb.analytes.each { |k, v| Array(v["sources"]).each { |s| missing << "analytes[#{k}] -> #{s}" unless ids.include?(s) } }
    @kb.relationships.each_with_index { |e, i| missing << "rel[#{i}] -> #{e['source']}" unless ids.include?(e["source"]) }
    @kb.conditions.each do |slug, c|
      Array(c["sources"]).each { |s| missing << "cond[#{slug}] -> #{s}" unless ids.include?(s) }
      missing << "cond[#{slug}].staging -> #{c.dig('staging', 'source')}" if c["staging"] && !ids.include?(c.dig("staging", "source"))
    end

    assert_empty missing, "unresolved source ids: #{missing.join(', ')}"
  end

  def test_every_source_has_name_and_url
    @kb.sources.each do |id, s|
      refute_nil s["name"], "#{id} missing name"
      assert_match %r{\Ahttps?://}, s["url"].to_s, "#{id} missing/invalid url"
    end
  end

  def test_relationship_endpoints_are_known_analytes
    known = analyte_keys_in_yaml.to_set
    @kb.relationships.each_with_index do |e, i|
      assert_equal 2, Array(e["between"]).size, "rel[#{i}] must link exactly two metrics"
      e["between"].each do |k|
        assert known.include?(k), "rel[#{i}] references '#{k}' which has no analyte entry"
      end
      refute_nil e["reason"], "rel[#{i}] missing reason"
    end
  end

  def test_condition_metrics_have_analyte_context
    # Some conditions are intentionally bloodwork-less (osteoarthritis, dental,
    # cognitive dysfunction) and carry no metrics. Any metric that IS listed must
    # reference an analyte we have written context for, and must state a role.
    known = analyte_keys_in_yaml.to_set
    @kb.conditions.each do |slug, c|
      Array(c["metrics"]).each do |m|
        assert known.include?(m["analyte"]), "cond[#{slug}] metric '#{m['analyte']}' has no analyte entry"
        refute_nil m["role"], "cond[#{slug}] metric '#{m['analyte']}' missing role"
      end
    end
  end

  def test_bloodworkless_conditions_have_signs_and_diagnosis
    # A condition with no metrics is only useful if it tells the owner what to
    # watch for and how it's actually diagnosed.
    @kb.conditions.each do |slug, c|
      next unless Array(c["metrics"]).empty?
      refute_empty Array(c["signs"]), "bloodwork-less condition #{slug} should list signs to watch"
      refute_empty Array(c["missing_markers"]), "bloodwork-less condition #{slug} should say how it's diagnosed"
    end
  end

  def test_ckd_staging_bands_are_ordered_and_complete
    ckd = @kb.conditions["chronic-kidney-disease"]
    refute_nil ckd
    %w[creatinine sdma].each do |k|
      bands = ckd.dig("staging", k, "bands")
      assert_equal [1, 2, 3, 4], bands.map { |b| b["stage"] }, "#{k} bands must cover stages 1-4 in order"
    end
  end

  def test_life_stages_present_and_ordered
    stages = @kb.life_stages
    refute_empty stages
    mins = stages.map { |s| s["min_years"] }
    assert_equal mins.sort, mins, "life stages must be ordered by ascending min_years"
    assert(stages.all? { |s| s["name"] && s["range"] }, "each life stage needs a name and range")
  end

  def test_life_stage_watch_conditions_and_sources_resolve
    condition_slugs = @kb.conditions.keys.to_set
    source_ids = @kb.sources.keys.to_set
    @kb.life_stages.each do |s|
      Array(s["sources"]).each { |id| assert source_ids.include?(id), "life stage #{s['slug']} cites unknown source #{id}" }
      Array(s["watch"]).each do |w|
        next unless w["condition"]
        assert condition_slugs.include?(w["condition"]),
               "life stage #{s['slug']} watches unknown condition '#{w['condition']}'"
      end
    end
  end

  def test_validate_reports_unknown_keys
    # A made-up key not present in the data should surface as a warning.
    warnings = @kb.validate(["Chemistry / Creatinine"])
    assert warnings.any? { |w| w.include?("matches no imported analyte") },
           "validate should flag analyte keys absent from the data"
  end
end
