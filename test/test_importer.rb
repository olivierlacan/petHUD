# frozen_string_literal: true

# Run with: ruby -Ilib -Itest test/test_importer.rb
#
# Batch imports must be per-file fault isolated: one PDF that can't be parsed
# names itself and lets the rest of the batch through, instead of aborting the
# run with a backtrace that doesn't say which file was at fault.
require "minitest/autorun"
require "pethud/importer"

class TestImporterBatch < Minitest::Test
  # Stands in for the real pipeline: raises for paths whose name says "bad".
  class StubImporter < PetHUD::Importer
    def initialize = nil # skip the real Database/Resolver/Exporter wiring

    def import(path, force: false)
      raise IOError, "pdftotext failed for #{path}" if path.include?("bad")

      Result.new(status: :imported, report_id: 1, source: path,
                 patient: Struct.new(:slug).new("iris"),
                 parsed: { meta: { pet_name: "IRIS", result_date: "2025-01-01" },
                           sections: [{ measurements: [{ name: "BUN" }] }] })
    end
  end

  def test_a_failing_file_does_not_abort_the_batch
    results = StubImporter.new.import_all(["a.pdf", "bad.pdf", "c.pdf"])

    assert_equal %i[imported failed imported], results.map(&:status)
  end

  def test_the_failure_names_its_own_file_and_cause
    failed = StubImporter.new.import_all(["a.pdf", "bad.pdf"]).find { |r| r.status == :failed }

    assert_equal "bad.pdf", failed.source
    assert_kind_of IOError, failed.error
    assert_includes failed.error.message, "bad.pdf"
  end

  def test_every_result_is_still_yielded_for_progress_reporting
    seen = []
    StubImporter.new.import_all(["a.pdf", "bad.pdf"]) { |r| seen << [r.status, r.source] }

    assert_equal [[:imported, "a.pdf"], [:failed, "bad.pdf"]], seen
  end
end
