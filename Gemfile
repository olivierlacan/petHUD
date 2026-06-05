source "https://rubygems.org"

ruby ">= 3.1"

# The only runtime dependency. Mature, ships with the SQLite amalgamation,
# and is maintained under the sparklemotion org. Everything else is stdlib.
gem "sqlite3", "~> 2.0"

# Tooling only (not needed to run the app): generates the synthetic demo PDFs in
# samples/ via scripts/make_sample_pdfs.rb. Install with: bundle install --with tools
group :tools, optional: true do
  gem "prawn", "~> 2.5"
end
