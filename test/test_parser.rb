# frozen_string_literal: true

# Run with: ruby -Ilib -Itest test/test_parser.rb
require "minitest/autorun"
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
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    m = r[:meta]
    assert_equal "IRIS REED", m[:pet_name]
    assert_equal "REED", m[:pet_owner]
    assert_equal "Feline", m[:species]
    assert_equal "900901", m[:patient_external_id]
    assert_equal "4400000001", m[:lab_id]
    assert_equal "2023-09-13", m[:result_date]
    assert_equal "Riverside Animal Clinic", m[:clinic][:name]
  end

  def test_numeric_measurement_with_units_and_range
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    sdma = measurement(r, "Chemistry", "IDEXX SDMA")
    assert_in_delta 14.0, sdma[:value], 0.001
    assert_equal "µg/dL", sdma[:unit]
    assert_in_delta 0.0, sdma[:ref_low], 0.001
    assert_in_delta 14.0, sdma[:ref_high], 0.001
    assert sdma[:numeric]
  end

  def test_printed_low_flag_is_captured
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    alt = measurement(r, "Chemistry", "ALT")
    assert_equal 26.0, alt[:value]
    assert_equal "L", alt[:flag]
  end

  def test_high_flag_derived_from_range
    r = parse("2026-05-26-IRIS-PARK-7000000003.pdf")
    creat = measurement(r, "Chemistry", "Creatinine")
    assert_equal 2.9, creat[:value]
    assert_equal "H", creat[:flag] # 2.9 > 2.3
  end

  def test_wrapped_name_is_stitched
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    refute_nil measurement(r, "Chemistry", "Bilirubin - Conjugated")
    refute_nil measurement(r, "Chemistry", "BUN: Creatinine Ratio")
  end

  def test_less_than_qualifier
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    conj = measurement(r, "Chemistry", "Bilirubin - Conjugated")
    assert_equal "<", conj[:qualifier]
    assert_in_delta 0.1, conj[:value], 0.001
  end

  def test_multiple_prior_columns_ignored
    # The Catalyst report has two historical columns; we must keep the current.
    r = parse("2026-06-02-IRIS-PARK-320000001.pdf")
    glu = measurement(r, "Chemistry", "Glucose")
    assert_equal 76.0, glu[:value]
    assert_equal "mg/dL", glu[:unit]
  end

  def test_qualitative_result_is_non_numeric
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    felv = measurement(r, "Serology", "FeLV Antigen (ELISA)")
    assert_equal "NEGATIVE", felv[:result_text]
    refute felv[:numeric]
  end

  def test_prose_routed_to_notes_not_measurements
    r = parse("2026-02-27-IRIS-PARK-7000000002.pdf")
    para = r[:sections].find { |s| s[:name] == "Parasitology" }
    names = para[:measurements].map { |m| m[:name] }
    refute_includes names, "Key:"
    assert para[:notes].any? { |n| n[:name].to_s.start_with?("Key") || n[:text].to_s =~ /reference interval/ }
  end

  def test_wrapped_urinalysis_names_are_stitched
    # This report's UA layout wraps long names onto a second line ("Blood /" +
    # "Hemoglobin", "White Blood" + "Cells"); the parser must rejoin them rather
    # than emit fragment rows.
    r = parse("2023-09-13-IRIS-REED-1538.pdf")
    names = r[:sections].find { |s| s[:name] == "Urinalysis" }[:measurements].map { |m| m[:name] }
    assert_includes names, "Blood / Hemoglobin"
    assert_includes names, "White Blood Cells"
    %w[Blood\ / Hemoglobin White\ Blood Cells].each { |frag| refute_includes names, frag }
  end

  def test_remarks_routed_to_notes_not_measurements
    r = parse("2026-02-27-IRIS-PARK-7000000002.pdf")
    heme = r[:sections].find { |s| s[:name] == "Hematology" }
    refute_includes heme[:measurements].map { |m| m[:name] }, "Remarks"
  end

  def test_all_samples_parse_without_error
    Dir[File.join(SAMPLES, "*.pdf")].each do |f|
      r = PetHUD::ReportParser.parse(f)
      assert r[:sections].sum { |s| s[:measurements].size } > 0, "#{File.basename(f)} produced no measurements"
    end
  end
end

class TestPatientResolver < Minitest::Test
  def setup
    @resolver = PetHUD::PatientResolver.new(File.expand_path("../config/patients.json", __dir__))
  end

  def test_aliases_merge_to_one_patient
    a = @resolver.resolve(pet_name: "IRIS REED", pet_owner: "REED", patient_external_id: "900901", species: "Feline")
    b = @resolver.resolve(pet_name: "IRIS PARK", pet_owner: "PARK", patient_external_id: "900902", species: "Feline")
    assert_equal "iris", a.slug
    assert_equal a.slug, b.slug
  end

  def test_unmatched_report_gets_auto_patient
    p = @resolver.resolve(pet_name: "REX", pet_owner: "SMITH", patient_external_id: "999", species: "Canine")
    refute_equal "iris", p.slug
    assert p.notes =~ /Auto-created/
  end

  def test_name_matches_as_leading_word_not_exact
    # pet_name is "<NAME> <OWNER SURNAME>"; the rule name "IRIS" must still match.
    a = @resolver.resolve(pet_name: "IRIS REED", pet_owner: "REED", patient_external_id: "x", species: "Feline")
    assert_equal "iris", a.slug
  end

  def test_same_owner_different_pet_is_isolated
    # The bug: a different cat in the same household (owner REED) must NOT be
    # merged into Iris just because the owner matches.
    p = @resolver.resolve(pet_name: "P'TIT LOUP REED", pet_owner: "REED", patient_external_id: "900903", species: "Feline")
    refute_equal "iris", p.slug
    assert_equal "p-tit-loup", p.slug
    assert_equal "P'tit Loup", p.name # owner surname stripped from the auto name
  end

  def test_owner_alone_does_not_match
    # A pet whose name doesn't match but whose owner is in a (legacy) rule must
    # not match on owner.
    p = @resolver.resolve(pet_name: "MITTENS PARK", pet_owner: "PARK", patient_external_id: "0", species: "Feline")
    refute_equal "iris", p.slug
  end

  def test_auto_name_strips_owner_surname_last_word
    # pet_name "<NAME> <SURNAME>" where surname is the owner's last word.
    p = @resolver.resolve(pet_name: "P'TIT LOUP PARK", pet_owner: "MAYA PARK", patient_external_id: "900904", species: "Feline")
    assert_equal "P'tit Loup", p.name
  end
end
