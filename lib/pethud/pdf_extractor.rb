# frozen_string_literal: true

require "open3"

module PetHUD
  # Turns a PDF into positioned words and lines by shelling out to poppler's
  # `pdftotext -tsv`. We rely on word coordinates (not visual column spacing)
  # so the parser can derive column anchors per-section and stay robust across
  # the different IDEXX report layouts.
  module PdfExtractor
    Word = Struct.new(:page, :x, :y, :w, :h, :text, keyword_init: true) do
      def right = x + w
      def cx = x + (w / 2.0)
    end

    # A visual line: words sharing roughly the same baseline, left-to-right.
    Line = Struct.new(:page, :y, :words, keyword_init: true) do
      def text = words.map(&:text).join(" ")
      def first = words.first
      # Words whose left edge falls within [lo, hi).
      def in_columns(lo, hi) = words.select { |w| w.x >= lo && w.x < hi }
    end

    module_function

    # Vertical tolerance (pts) for grouping words onto the same line.
    LINE_TOLERANCE = 3.0

    def binary
      ENV.fetch("PDFTOTEXT", "pdftotext")
    end

    def available?
      _out, _err, status = Open3.capture3(binary, "-v")
      status.success? || status.exitstatus == 99 # -v prints to stderr, exit varies
    rescue Errno::ENOENT
      false
    end

    # Returns an Array<Word> for every page in reading order.
    def words(path)
      out, err, status = Open3.capture3(binary, "-tsv", "-nopgbrk", path.to_s, "-")
      unless status.success?
        raise "pdftotext failed for #{path}: #{err.strip}"
      end

      parse_tsv(out)
    end

    # Returns Array<Line>, grouped per page and sorted top-to-bottom.
    def lines(path)
      group_lines(words(path))
    end

    def parse_tsv(tsv)
      result = []
      tsv.each_line do |row|
        cols = row.split("\t")
        next unless cols[0] == "5" # level 5 == a word token

        text = cols[11]&.chomp
        next if text.nil? || text.empty?

        result << Word.new(
          page: cols[1].to_i,
          x: cols[6].to_f,
          y: cols[7].to_f,
          w: cols[8].to_f,
          h: cols[9].to_f,
          text: text
        )
      end
      result
    end

    def group_lines(words)
      by_page = words.group_by(&:page)
      lines = []

      by_page.keys.sort.each do |page|
        page_words = by_page[page].sort_by { |w| [w.y, w.x] }
        current = []
        current_y = nil

        page_words.each do |w|
          if current_y.nil? || (w.y - current_y).abs <= LINE_TOLERANCE
            current << w
            current_y ||= w.y
          else
            lines << build_line(page, current)
            current = [w]
            current_y = w.y
          end
        end
        lines << build_line(page, current) unless current.empty?
      end

      lines
    end

    def build_line(page, words)
      Line.new(page: page, y: words.map(&:y).min, words: words.sort_by(&:x))
    end
  end
end
