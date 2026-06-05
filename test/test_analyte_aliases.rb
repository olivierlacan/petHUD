# frozen_string_literal: true

# Run with: ruby -Ilib -Itest test/test_analyte_aliases.rb
require "minitest/autorun"
require "pethud"

class TestAnalyteAliases < Minitest::Test
  def c(section, name) = PetHUD::AnalyteAliases.canonical(section, name)

  def test_fragments_map_to_canonical
    assert_equal "Blood / Hemoglobin", c("Urinalysis", "Blood /")
    assert_equal "Blood / Hemoglobin", c("Urinalysis", "Hemoglobin")
    assert_equal "White Blood Cells", c("Urinalysis", "White Blood")
    assert_equal "Red Blood Cells", c("Urinalysis", "Red Blood")
    assert_equal "Collection Method", c("Urinalysis", "Collection")
    assert_equal "% Reticulocytes", c("Hematology", "% Reticulocyte")
    assert_equal "Ova & Parasites - Zinc Sulfate Centrifugation",
                 c("Parasitology", "Ova & Parasites - Zinc Sulfate")
  end

  def test_aliases_are_section_scoped
    # The Hematology hemoglobin (real CBC) must not be touched, even though the
    # Urinalysis "Hemoglobin" fragment is aliased.
    assert_equal "Hemoglobin", c("Hematology", "Hemoglobin")
  end

  def test_unaliased_names_pass_through
    assert_equal "Creatinine", c("Chemistry", "Creatinine")
    assert_equal "Cells", c("Urinalysis", "Cells") # ambiguous: intentionally not aliased
  end
end
