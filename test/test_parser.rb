# frozen_string_literal: true

# Run with: ruby -Ilib -Itest test/test_parser.rb
#
# This suite runs against the committed, fully synthetic demo reports
# (samples/demo-*.pdf) so it is safe to ship publicly. The exhaustive parser
# coverage over the real-world corpus lives in test/test_parser_local.rb, which
# is gitignored alongside the private PDFs it depends on.
require "minitest/autorun"
require "json"
require "tempfile"
require "pethud/report_parser"
require "pethud/patient_resolver"

SAMPLES = File.expand_path("../samples", __dir__)

class TestReportParser < Minitest::Test
  def parse(name)
    PetHUD::ReportParser.parse(File.join(SAMPLES, name))
  end

  def measurement(report, section, name)
    sec = report[:sections].find { |s| s[:name] == section }
    sec && sec[:measurements].find { |m| m[:name] == name }
  end

  def test_header_metadata
    r = parse("demo-willow-2025-09-03.pdf")
    m = r[:meta]
    assert_equal "WILLOW MARSH", m[:pet_name]
    assert_equal "MARSH", m[:pet_owner]
    assert_equal "Feline", m[:species]
    assert_equal "900118", m[:patient_external_id]
    assert_equal "2025-09-03", m[:result_date]
    assert_equal "Cedar Creek Animal Hospital", m[:clinic][:name]
  end

  def test_numeric_measurement_with_units_and_range
    r = parse("demo-willow-2025-09-03.pdf")
    creat = measurement(r, "Chemistry", "Creatinine")
    assert_in_delta 3.7, creat[:value], 0.001
    assert_equal "mg/dL", creat[:unit]
    assert_in_delta 0.8, creat[:ref_low], 0.001
    assert_in_delta 2.4, creat[:ref_high], 0.001
    assert creat[:numeric]
  end

  def test_high_flag_derived_from_range
    r = parse("demo-willow-2025-09-03.pdf")
    creat = measurement(r, "Chemistry", "Creatinine")
    assert_equal "H", creat[:flag] # 3.7 > 2.4
    sdma = measurement(r, "Chemistry", "IDEXX SDMA")
    assert_equal "H", sdma[:flag] # 33 > 14
  end

  def test_low_flag_captured
    r = parse("demo-willow-2025-09-03.pdf")
    k = measurement(r, "Chemistry", "Potassium")
    assert_in_delta 3.3, k[:value], 0.001
    assert_equal "L", k[:flag] # 3.3 < 3.5
  end

  def test_in_range_value_has_no_flag
    r = parse("demo-willow-2025-09-03.pdf")
    t4 = measurement(r, "Endocrinology", "Total T4")
    assert_in_delta 2.0, t4[:value], 0.001
    assert_nil t4[:flag]
  end

  def test_all_demo_samples_parse_without_error
    files = Dir[File.join(SAMPLES, "demo-*.pdf")]
    refute_empty files, "no committed demo PDFs found"
    files.each do |f|
      r = PetHUD::ReportParser.parse(f)
      assert r[:sections].sum { |s| s[:measurements].size } > 0, "#{File.basename(f)} produced no measurements"
    end
  end
end

class TestPatientResolver < Minitest::Test
  # A self-contained, fictional aliasing config so the resolver logic is tested
  # independently of whatever ships in config/patients.json. "Nimbus" stands in
  # for a cat seen under two households; "Pepper" is a second cat in one of them.
  CONFIG = {
    "patients" => [
      {
        "slug" => "nimbus",
        "name" => "Nimbus",
        "species" => "Feline",
        "notes" => "Same cat across two households.",
        "match" => { "names" => ["NIMBUS"], "external_ids" => ["900901", "900902"] }
      }
    ]
  }.freeze

  def setup
    @tmp = Tempfile.new(["patients", ".json"])
    @tmp.write(JSON.generate(CONFIG))
    @tmp.flush
    @resolver = PetHUD::PatientResolver.new(@tmp.path)
  end

  def teardown
    @tmp.close!
  end

  def test_aliases_merge_to_one_patient
    a = @resolver.resolve(pet_name: "NIMBUS REED", pet_owner: "REED", patient_external_id: "900901", species: "Feline")
    b = @resolver.resolve(pet_name: "NIMBUS PARK", pet_owner: "PARK", patient_external_id: "900902", species: "Feline")
    assert_equal "nimbus", a.slug
    assert_equal a.slug, b.slug
  end

  def test_unmatched_report_gets_auto_patient
    p = @resolver.resolve(pet_name: "REX", pet_owner: "SMITH", patient_external_id: "999", species: "Canine")
    refute_equal "nimbus", p.slug
    assert p.notes =~ /Auto-created/
  end

  def test_name_matches_as_leading_word_not_exact
    # pet_name is "<NAME> <OWNER SURNAME>"; the rule name "NIMBUS" must still match.
    a = @resolver.resolve(pet_name: "NIMBUS REED", pet_owner: "REED", patient_external_id: "x", species: "Feline")
    assert_equal "nimbus", a.slug
  end

  def test_same_owner_different_pet_is_isolated
    # A different cat in the same household (owner REED) must NOT be merged into
    # Nimbus just because the owner matches.
    p = @resolver.resolve(pet_name: "PEPPER REED", pet_owner: "REED", patient_external_id: "900903", species: "Feline")
    refute_equal "nimbus", p.slug
    assert_equal "pepper", p.slug
    assert_equal "Pepper", p.name # owner surname stripped from the auto name
  end

  def test_owner_alone_does_not_match
    # A pet whose name doesn't match but whose owner appears in a rule must not
    # match on owner.
    p = @resolver.resolve(pet_name: "MITTENS PARK", pet_owner: "PARK", patient_external_id: "0", species: "Feline")
    refute_equal "nimbus", p.slug
  end

  def test_auto_name_strips_owner_surname_last_word
    # pet_name "<NAME> <SURNAME>" where surname is the owner's last word.
    p = @resolver.resolve(pet_name: "PEPPER PARK", pet_owner: "MAYA PARK", patient_external_id: "900904", species: "Feline")
    assert_equal "Pepper", p.name
  end
end
