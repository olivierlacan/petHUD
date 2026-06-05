# frozen_string_literal: true

# Generate synthetic IDEXX-style sample PDFs with designed value trends, so
# pethud can be demoed without anyone's real pet data. Text is placed at the
# exact point coordinates of a real VetConnect PLUS report, so the parser
# ingests the output unchanged (verified by re-importing it).
#
#   gem install prawn         # one-time (also in Gemfile :tools group)
#   ruby scripts/make_sample_pdfs.rb         # generate all -> samples/demo-*.pdf
#   ruby scripts/make_sample_pdfs.rb --one   # just the first report (spike)
#
# All patients/clinics/vets are fictional.

require "prawn"

PAGE_W = 612
PAGE_H = 792

# Analyte catalog: section, display name, unit, reference interval by species.
A = {
  bun:         ["Chemistry", "BUN", "mg/dL", { feline: [16, 36], canine: [9, 31] }],
  creatinine:  ["Chemistry", "Creatinine", "mg/dL", { feline: [0.8, 2.4], canine: [0.5, 1.8] }],
  sdma:        ["Chemistry", "IDEXX SDMA", "µg/dL", { feline: [0, 14], canine: [0, 14] }],
  phosphorus:  ["Chemistry", "Phosphorus", "mg/dL", { feline: [3.1, 7.5], canine: [2.5, 6.8] }],
  calcium:     ["Chemistry", "Calcium", "mg/dL", { feline: [8.2, 11.8], canine: [7.9, 12.0] }],
  totalprot:   ["Chemistry", "Total Protein", "g/dL", { feline: [5.7, 8.9], canine: [5.0, 7.4] }],
  albumin:     ["Chemistry", "Albumin", "g/dL", { feline: [2.3, 3.9], canine: [2.7, 4.4] }],
  globulin:    ["Chemistry", "Globulin", "g/dL", { feline: [2.8, 5.1], canine: [1.6, 3.6] }],
  glucose:     ["Chemistry", "Glucose", "mg/dL", { feline: [71, 159], canine: [70, 138] }],
  alt:         ["Chemistry", "ALT", "U/L", { feline: [12, 130], canine: [18, 121] }],
  alp:         ["Chemistry", "ALP", "U/L", { feline: [14, 111], canine: [5, 160] }],
  cholesterol: ["Chemistry", "Cholesterol", "mg/dL", { feline: [65, 225], canine: [110, 320] }],
  potassium:   ["Chemistry", "Potassium", "mmol/L", { feline: [3.5, 5.8], canine: [3.5, 5.8] }],
  sodium:      ["Chemistry", "Sodium", "mmol/L", { feline: [150, 165], canine: [142, 152] }],
  hct:         ["Hematology", "Hematocrit", "%", { feline: [28, 49], canine: [37, 55] }],
  hgb:         ["Hematology", "Hemoglobin", "g/dL", { feline: [9.8, 16.2], canine: [12, 18] }],
  wbc:         ["Hematology", "WBC", "K/µL", { feline: [3.9, 19.0], canine: [4.0, 15.5] }],
  platelets:   ["Hematology", "Platelets", "K/µL", { feline: [151, 600], canine: [148, 484] }],
  t4:          ["Endocrinology", "Total T4", "µg/dL", { feline: [0.8, 4.0], canine: [1.0, 4.0] }],
  usg:         ["Urinalysis", "Specific Gravity", "", { feline: [1.035, 1.060], canine: [1.015, 1.045] }]
}.freeze
SECTION_ORDER = ["Hematology", "Chemistry", "Endocrinology", "Urinalysis"].freeze
PANEL = %i[creatinine sdma bun phosphorus calcium totalprot albumin globulin glucose alt alp
           cholesterol potassium sodium hct hgb wbc platelets t4 usg].freeze

BASE = {
  feline: { bun: 24, creatinine: 1.5, sdma: 11, phosphorus: 4.6, calcium: 9.8, totalprot: 7.2, albumin: 3.1,
            globulin: 3.8, glucose: 95, alt: 55, alp: 40, cholesterol: 150, potassium: 4.4, sodium: 152,
            hct: 40, hgb: 13.0, wbc: 9.5, platelets: 320, t4: 2.0, usg: 1.045 },
  canine: { bun: 18, creatinine: 1.0, sdma: 9, phosphorus: 4.0, calcium: 10.2, totalprot: 6.2, albumin: 3.4,
            globulin: 2.6, glucose: 95, alt: 50, alp: 70, cholesterol: 200, potassium: 4.4, sodium: 146,
            hct: 48, hgb: 16.0, wbc: 9.0, platelets: 300, t4: 1.8, usg: 1.030 }
}.freeze

CLINICS = {
  cedar:   ["Cedar Creek Animal Hospital", "118 Birchwood Lane", "Asheville, NC 28801", "1 828 555-0142"],
  harbor:  ["Harborview Veterinary Clinic", "2204 Marina Blvd", "Portland, OR 97209", "1 503 555-0188"],
  prairie: ["Prairie Rose Pet Hospital", "65 Meadowlark Rd", "Madison, WI 53703", "1 608 555-0177"]
}.freeze

PATIENTS = [
  { pet: "WILLOW MARSH", owner: "MARSH", sp: :feline, species: "Feline", breed: "Shorthair, Domestic",
    gender: "Female Spayed", id: "900118", clinic: :cedar, vet: "Dana Holloway DVM",
    services: "Chem 15 CLIP + CBC + SDMA + T4 + UA", ages: ["13 Years", "13 Years", "14 Years", "14 Years"],
    dates: ["02/14/24", "08/20/24", "02/26/25", "09/03/25"],
    trend: { creatinine: [1.7, 2.1, 2.9, 3.7], sdma: [15, 19, 26, 33], bun: [29, 36, 47, 60],
             phosphorus: [4.6, 5.3, 6.5, 7.9], potassium: [4.2, 3.9, 3.6, 3.3], hct: [38, 34, 30, 27],
             hgb: [12.6, 11.2, 9.9, 9.0], usg: [1.035, 1.022, 1.015, 1.011] } },
  { pet: "OTIS BRANNON", owner: "BRANNON", sp: :feline, species: "Feline", breed: "Shorthair, Domestic",
    gender: "Male Neutered", id: "900233", clinic: :harbor, vet: "Priya Raman DVM",
    services: "T4 + Chem 15 CLIP + CBC", ages: ["12 Years", "12 Years", "13 Years"],
    dates: ["03/05/24", "06/18/24", "12/02/24"],
    trend: { t4: [8.6, 4.4, 2.1], alt: [148, 104, 71], creatinine: [1.2, 1.6, 1.9], sdma: [10, 13, 16],
             hct: [44, 41, 39] } },
  { pet: "CLEO FENWICK", owner: "FENWICK", sp: :feline, species: "Feline", breed: "Maine Coon",
    gender: "Female Spayed", id: "900347", clinic: :prairie, vet: "Marcus Bell DVM",
    services: "Wellness Chem + CBC + T4 + UA", ages: ["7 Years", "8 Years", "8 Years"],
    dates: ["01/10/24", "01/15/25", "07/22/25"],
    trend: { creatinine: [1.4, 1.5, 1.4], sdma: [10, 11, 10], glucose: [92, 98, 95], t4: [2.1, 1.9, 2.2],
             hct: [41, 40, 42], usg: [1.046, 1.050, 1.044] } },
  { pet: "MOCHI DELACROIX", owner: "DELACROIX", sp: :feline, species: "Feline", breed: "Shorthair, Domestic",
    gender: "Male Neutered", id: "900462", clinic: :harbor, vet: "Priya Raman DVM",
    services: "Chem 15 CLIP + CBC + Fructosamine", ages: ["9 Years", "9 Years", "10 Years"],
    dates: ["04/02/24", "07/09/24", "11/19/24"],
    trend: { glucose: [322, 261, 148], cholesterol: [292, 246, 198], alp: [98, 120, 76], alt: [96, 110, 64],
             sodium: [156, 154, 152] } },
  { pet: "BAXTER COLE", owner: "COLE", sp: :canine, species: "Canine", breed: "Labrador Retriever",
    gender: "Male Neutered", id: "900571", clinic: :cedar, vet: "Dana Holloway DVM",
    services: "Wellness Chem + CBC + Heartworm", ages: ["6 Years", "7 Years", "8 Years"],
    dates: ["05/01/23", "05/14/24", "06/03/25"],
    trend: { alp: [78, 132, 168], cholesterol: [205, 230, 248], creatinine: [1.0, 1.1, 1.2], glucose: [96, 99, 101] } }
].freeze

def fmt(v)
  s = format("%.3f", v)
  s = s.sub(/\.?0+\z/, "") if s.include?(".")
  s
end

def iso(mdy)
  m, d, y = mdy.split("/")
  "20#{y}-#{m}-#{d}"
end

def draw(pdf, x, top, text, size: 9, bold: false)
  pdf.font("Helvetica", style: bold ? :bold : :normal) do
    pdf.draw_text(text, at: [x, PAGE_H - top], size: size)
  end
end

def render_report(rep, out_path)
  Prawn::Document.generate(out_path, page_size: [PAGE_W, PAGE_H], margin: 0) do |pdf|
    draw(pdf, 27, 40, rep[:pet], bold: true)
    [["PET OWNER:", rep[:owner]], ["SPECIES:", rep[:species]], ["BREED:", rep[:breed]],
     ["GENDER:", rep[:gender]], ["AGE:", rep[:age]], ["PATIENT ID:", rep[:id]]].each_with_index do |(lab, val), i|
      y = 64 + i * 12
      draw(pdf, 38, y, lab); draw(pdf, 92, y, val)
    end
    c = rep[:clinic]
    [c[0], c[1], c[2], c[3], "ACCOUNT #:    #{rep[:account]}", "ATTENDING VET: #{rep[:vet]}"].each_with_index do |t, i|
      draw(pdf, 250, 64 + i * 12, t)
    end
    [["LAB ID:", rep[:lab_id]], ["ORDER ID:", rep[:order_id]], ["COLLECTION DATE:", rep[:date]],
     ["DATE OF RECEIPT:", rep[:date]], ["DATE OF RESULT:", rep[:date]]].each_with_index do |(lab, val), i|
      y = 64 + i * 12
      draw(pdf, 462, y, lab); draw(pdf, 548, y, val)
    end
    draw(pdf, 27, 150, "IDEXX Services: #{rep[:services]}")

    y = 182
    SECTION_ORDER.each do |sec|
      rows = rep[:rows].select { |r| A[r[0]][0] == sec }
      next if rows.empty?

      draw(pdf, 27, y, sec, bold: true); y += 22
      draw(pdf, 27, y, "TEST"); draw(pdf, 136, y, "RESULT"); draw(pdf, 224, y, "REFERENCE"); draw(pdf, 272, y, "VALUE"); y += 17
      rows.each do |key, value|
        _, name, unit, ranges = A[key]
        lo, hi = ranges[rep[:sp]]
        draw(pdf, 27, y, name)
        draw(pdf, 136, y, fmt(value))
        ref = unit.empty? ? "#{fmt(lo)} - #{fmt(hi)}" : "#{fmt(lo)} - #{fmt(hi)} #{unit}"
        draw(pdf, 224, y, ref)
        y += 17
      end
      y += 8
    end
  end
end

def build_reports
  seq = 70_000
  reports = []
  PATIENTS.each do |p|
    p[:dates].each_with_index do |date, i|
      values = BASE[p[:sp]].dup
      p[:trend].each { |k, arr| values[k] = arr[i] }
      rows = PANEL.map { |k| [k, values[k]] }
      reports << {
        file: "demo-#{p[:pet].split.first.downcase}-#{iso(date)}.pdf",
        pet: p[:pet], owner: p[:owner], species: p[:species], sp: p[:sp], breed: p[:breed],
        gender: p[:gender], age: p[:ages][i], id: p[:id], lab_id: (seq += 1).to_s, order_id: (seq += 1).to_s,
        account: "10#{p[:id][-3..]}", vet: p[:vet], clinic: CLINICS[p[:clinic]], date: date,
        services: p[:services], rows: rows
      }
    end
  end
  reports
end

out_dir = File.expand_path("../samples", __dir__)
Dir.mkdir(out_dir) unless Dir.exist?(out_dir)
reports = build_reports
reports = reports.first(1) if ARGV.include?("--one")
reports.each do |rep|
  path = File.join(out_dir, rep[:file])
  render_report(rep, path)
  puts "wrote samples/#{rep[:file]}"
end
puts "\n#{reports.size} PDF(s) generated."
