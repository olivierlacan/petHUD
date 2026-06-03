# frozen_string_literal: true

require "date"
require "digest"
require_relative "pdf_extractor"

module PetHUD
  # Parses one IDEXX VetConnect PLUS lab report PDF into a structured Hash.
  #
  # Strategy: pull positioned words via PdfExtractor, group into visual lines,
  # then walk the lines as a small state machine. Column boundaries are derived
  # *per section* from that section's own "TEST / RESULT / REFERENCE VALUE"
  # header row, so the parser absorbs the layout shifts between report variants
  # (full senior screens, chemistry-only, in-house Catalyst analyzer, etc.).
  class ReportParser
    # Section titles we recognize. A line is a section header when it equals one
    # of these (optionally followed by "(continued)").
    SECTIONS = [
      "Hematology", "Chemistry", "Urinalysis", "Urine Chemistry",
      "Endocrinology", "Serology", "Immunology", "Parasitology",
      "Microbiology", "Cytology", "Coagulation", "Infectious Disease"
    ].freeze

    SECTION_RE = /\A(#{SECTIONS.map { |s| Regexp.escape(s) }.join('|')})(?:\s*\(continued\))?\z/

    # Lines that are page furniture / prose, never measurement rows.
    NOISE_RE = %r{
      PET\sOWNER: | DATE\sOF\sRESULT: | LAB\sID: |
      Generated\sby\sVetConnect | Page\s\d+\sof\s\d+ |
      \A1\s8\d\d | \A\d{3}-\d{3}-\d{4}\z
    }x

    attr_reader :path, :lines

    def initialize(path)
      @path = path.to_s
      @lines = PdfExtractor.lines(@path)
    end

    def self.parse(path)
      new(path).parse
    end

    def parse
      meta = parse_header
      sections = parse_sections(meta)
      {
        source_file: File.basename(@path),
        file_sha256: Digest::SHA256.file(@path).hexdigest,
        meta: meta,
        sections: sections
      }
    end

    # --- Header -----------------------------------------------------------

    # The header block (page 1) is label/value pairs laid out in three columns.
    # We read it from layout text where the visual columns are easiest to slice.
    def parse_header
      text = layout_first_page
      lines = text.lines.map(&:rstrip)

      meta = {}
      meta[:pet_name]      = lines.find { |l| l.strip =~ /\A[A-Z][A-Z .'-]+\z/ }&.strip
      meta[:pet_owner]     = field(text, "PET OWNER")
      meta[:species]       = field(text, "SPECIES")
      meta[:breed]         = field(text, "BREED")
      meta[:gender]        = field(text, "GENDER")
      meta[:age_text]      = field(text, "AGE")
      meta[:patient_external_id] = field(text, "PATIENT ID")
      meta[:lab_id]        = token_field(text, "LAB ID")
      meta[:order_id]      = token_field(text, "ORDER ID")
      meta[:account_number] = token_field(text, "ACCOUNT #")
      meta[:attending_vet] = field(text, "ATTENDING VET")
      meta[:collection_date] = normalize_date(token_field(text, "COLLECTION DATE"))
      meta[:received_date]   = normalize_date(token_field(text, "DATE OF RECEIPT"))
      meta[:result_date]     = normalize_date(token_field(text, "DATE OF RESULT"))
      meta[:age_years]     = parse_age_years(meta[:age_text])
      meta[:clinic]        = parse_clinic(lines)
      meta[:idexx_services] = parse_services(text)
      meta
    end

    # Value of a labelled field, captured up to a 2+ space gap (column break).
    def field(text, label)
      m = text.match(/#{Regexp.escape(label)}:\s*(\S.*?)(?:\s{2,}|\n|\z)/)
      m && m[1].strip
    end

    # Single-token value (ids, dates).
    def token_field(text, label)
      m = text.match(/#{Regexp.escape(label)}:\s*(\S+)/)
      v = m && m[1].strip
      v && v.empty? ? nil : v
    end

    # Clinic name sits in the middle column of the "PET OWNER" header row:
    # "PET OWNER: <owner>   <clinic name>   LAB ID: <id>".
    def parse_clinic(lines)
      row = lines.find { |l| l =~ /PET OWNER:/ }
      return { name: nil } unless row

      chunks = row.split(/\s{2,}/).reject(&:empty?)
      # Drop the "PET OWNER: <owner>" chunk(s) and the trailing id label/value.
      mid = chunks.reject { |c| c =~ /\A(PET OWNER:|LAB ID:|\d+)/ }
      mid.shift if mid.first && mid.first !~ /[a-z]/ && mid.length > 1 # owner value
      { name: mid.first }
    end

    def parse_services(text)
      m = text.match(/IDEXX Services:\s*(.+)/)
      m && m[1].strip
    end

    def parse_age_years(age_text)
      return nil unless age_text
      if (m = age_text.match(/(\d+)\s*Year/i))
        m[1].to_i
      elsif (m = age_text.match(/(\d+)\s*Month/i))
        (m[1].to_f / 12).round(1)
      end
    end

    def layout_first_page
      out, _err, status = Open3.capture3(
        PdfExtractor.binary, "-layout", "-f", "1", "-l", "1", @path, "-"
      )
      status.success? ? out : ""
    end

    # --- Sections & measurements -----------------------------------------

    NAME_ANCHOR_SLACK = 48  # a row's leftmost word must start within this of name_x
    CONT_GAP = 13.0         # max vertical gap (pts) for a wrapped name fragment

    def parse_sections(meta)
      sections = []
      current = nil
      cols = nil          # column anchors for the active table
      in_table = false
      last_measurement = nil
      last_y = nil        # y of the most recently consumed table line

      @lines.each do |line|
        txt = line.text.strip
        next if txt.empty?

        # Section header — opens a new section, table not yet active.
        if (m = txt.match(SECTION_RE))
          name = m[1]
          current = sections.find { |s| s[:name] == name }
          unless current
            current = { name: name, measurements: [] }
            sections << current
          end
          in_table = false
          cols = nil
          last_measurement = nil
          next
        end

        # Page furniture / running headers: disable the active table until the
        # column header repeats on the new page.
        if txt =~ NOISE_RE || txt == meta[:pet_name]
          in_table = false
          next
        end

        next if current.nil?

        # Column header row defines this section's column geometry.
        if (c = detect_columns(line))
          cols = c
          in_table = true
          last_measurement = nil
          last_y = line.y
          next
        end

        # Sub-headers carrying section timestamps.
        if txt =~ /\(Order Received\)|\(Last Updated\)/
          capture_section_dates(current, txt)
          next
        end

        next unless in_table && cols

        row = classify_row(line, cols)
        next if row[:type] == :noise

        # A row with its own value is always a new measurement. A value-less row
        # hugging the previous line (small gap) is a wrapped name fragment;
        # otherwise it is a distinct (often qualitative/empty) measurement.
        continuation = !row[:has_value] && last_measurement &&
                       last_y && (line.y - last_y) <= CONT_GAP

        if continuation
          last_measurement[:name] = "#{last_measurement[:name]} #{row[:name]}".strip
        else
          m = build_measurement(row, current[:name])
          if note?(m[:name], m[:result_text])
            (current[:notes] ||= []) << { name: m[:name], text: m[:result_text] }
            last_measurement = nil # a note never absorbs the next wrapped line
          else
            current[:measurements] << m
            last_measurement = m
          end
        end
        last_y = line.y
      end

      sections.reject! { |s| s[:measurements].empty? && (s[:notes].nil? || s[:notes].empty?) }
      sections
    end

    # Free-text annotations that ride in the result table but aren't analytes:
    # clinical-history blurbs, legends, "info needed" prose, etc.
    NOTE_NAME_RE = /\A\*|Clinical History|INFO NEEDED|Fecal Note|\AOther\z|\ANote\b|\AKey\b/i

    def note?(name, result_text)
      return true if name =~ NOTE_NAME_RE
      return true if name.end_with?(":") && result_text.to_s.strip.empty?
      result_text.to_s.split.length >= 7 # prose, not a result token
    end

    # Detect the "TEST / RESULT / REFERENCE VALUE" header and return anchors.
    def detect_columns(line)
      result = line.words.find { |w| w.text == "RESULT" }
      return nil unless result

      test = line.words.find { |w| w.text == "TEST" }
      reference = line.words.find { |w| w.text == "REFERENCE" }

      name_x = test ? test.x : 27.0
      result_x = result.x
      ref_x = reference&.x

      prior_lo = [(ref_x || result_x) + 230.0, 440.0].max
      {
        name_x: name_x,
        name_hi: result_x - 8.0,
        result_lo: result_x - 8.0,
        result_hi: ref_x ? ref_x - 8.0 : prior_lo,
        ref_lo: ref_x ? ref_x - 8.0 : nil,
        ref_hi: prior_lo,
        prior_lo: prior_lo
      }
    end

    # Classify a line within an active table into a measurement / continuation /
    # noise row, slicing words into columns by their x position.
    def classify_row(line, cols)
      leftmost = line.words.first
      # Footnote markers (lone lowercase letter) and prose sit indented past the
      # name column; genuine analyte names hug the left margin.
      unless leftmost && leftmost.x <= cols[:name_x] + NAME_ANCHOR_SLACK
        return { type: :noise }
      end
      return { type: :noise } if leftmost.text =~ /\A[a-z]\z/ # footnote marker

      name_words   = line.words.select { |w| w.x < cols[:name_hi] }
      result_words = line.words.select { |w| w.x >= cols[:result_lo] && w.x < cols[:result_hi] }
      ref_words    = cols[:ref_lo] ? line.words.select { |w| w.x >= cols[:ref_lo] && w.x < cols[:ref_hi] } : []

      name = name_words.map(&:text).join(" ").strip
      return { type: :noise } if name.empty?

      # Pull H/L flag tokens out of the reference column.
      flag = nil
      ref_kept = ref_words.reject do |w|
        if w.text == "H" || w.text == "L"
          flag = w.text
          true
        else
          false
        end
      end

      result = result_words.map(&:text).join(" ").strip
      reference = ref_kept.map(&:text).join(" ").strip
      # A real reference carries digits/units; a lone "<"/">" is prior-column
      # punctuation that bled left and must not be read as a value.
      meaningful_ref = reference.match?(/[0-9A-Za-z%]/)

      {
        type: :row,
        name: name,
        result: result,
        reference: meaningful_ref ? reference : "",
        flag: flag,
        has_value: !result.empty? || meaningful_ref
      }
    end

    def build_measurement(row, _section)
      result_text = row[:result]
      value, qualifier = parse_value(result_text)
      ref_low, ref_high, unit = parse_reference(row[:reference])
      flag = row[:flag]
      flag ||= derive_flag(value, ref_low, ref_high) unless value.nil?

      {
        name: row[:name],
        result_text: result_text,
        value: value,
        qualifier: qualifier,
        unit: unit,
        ref_low: ref_low,
        ref_high: ref_high,
        ref_text: row[:reference].empty? ? nil : row[:reference],
        flag: flag,
        numeric: !value.nil?
      }
    end

    # --- Value / reference parsing ---------------------------------------

    NUMBER = /-?\d+(?:\.\d+)?/

    def parse_value(text)
      return [nil, nil] if text.nil? || text.empty?
      s = text.strip
      if (m = s.match(/\A([<>])\s*(#{NUMBER})\z/))
        [m[2].to_f, m[1]]
      elsif s.match?(/\A#{NUMBER}\z/)
        [s.to_f, nil]
      else
        [nil, nil] # qualitative result (NEGATIVE, TRACE, 2+, NONE SEEN, ...)
      end
    end

    # "72 - 175 mg/dL" -> [72.0, 175.0, "mg/dL"]; "%" -> [nil, nil, "%"].
    def parse_reference(text)
      return [nil, nil, nil] if text.nil? || text.strip.empty?
      s = text.strip
      if (m = s.match(/\A(#{NUMBER})\s*-\s*(#{NUMBER})\s*(.*)\z/))
        unit = m[3].strip
        [m[1].to_f, m[2].to_f, unit.empty? ? nil : unit]
      else
        [nil, nil, s] # units only, or non-range reference
      end
    end

    def derive_flag(value, low, high)
      return nil if value.nil?
      return "L" if low && value < low
      return "H" if high && value > high
      nil
    end

    def capture_section_dates(section, txt)
      date = txt[/\d{1,2}\/\d{1,2}\/\d{2,4}/]
      iso = normalize_date(date)
      if txt =~ /\(Order Received\)/
        section[:order_received] ||= iso
      elsif txt =~ /\(Last Updated\)/
        section[:last_updated] ||= iso
      end
    end

    def normalize_date(str)
      return nil if str.nil? || str.strip.empty?
      s = str.strip
      formats = ["%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"]
      formats.each do |fmt|
        begin
          return Date.strptime(s, fmt).iso8601
        rescue ArgumentError
          next
        end
      end
      nil
    end
  end
end
