# frozen_string_literal: true

require "socket"
require "json"
require "uri"
require "fileutils"
require "time"

module PetHUD
  # A tiny HTTP/1.1 server built on stdlib TCPSocket only (no WEBrick, no Rack).
  # It serves the static viewer from web/ and accepts a dropped PDF as a raw
  # request body, runs the same import pipeline the CLI uses, regenerates
  # web/data.js, and returns the refreshed payload as JSON.
  #
  # The browser sends the PDF as the raw request body (not multipart) with the
  # filename in an X-Filename header, so body handling is just "read
  # Content-Length bytes" — no multipart parsing required.
  class Server
    MIME = {
      ".html" => "text/html; charset=utf-8",
      ".css"  => "text/css; charset=utf-8",
      ".js"   => "application/javascript; charset=utf-8",
      ".json" => "application/json; charset=utf-8",
      ".svg"  => "image/svg+xml",
      ".ico"  => "image/x-icon"
    }.freeze
    MAX_BODY = 50 * 1024 * 1024 # 50 MB upload ceiling

    def initialize(port: 8787, host: "127.0.0.1", web_dir: PetHUD.web_dir)
      @port = port
      @host = host
      @web_dir = File.expand_path(web_dir)
      @import_mutex = Mutex.new
    end

    def start(open: false)
      ensure_data_file
      server = TCPServer.new(@host, @port)
      url = "http://#{@host}:#{@port}/"
      puts "pethud viewer running at #{url}"
      puts "Drop IDEXX PDF reports onto the page to import them. Ctrl-C to stop."
      system("open", url) if open

      loop do
        client = server.accept
        Thread.new(client) { |c| handle(c) }
      end
    rescue Interrupt
      puts "\nStopped."
    ensure
      server&.close
    end

    private

    # If the viewer has never been generated, build it now so the page isn't blank.
    def ensure_data_file
      data = File.join(@web_dir, "data.js")
      return if File.exist?(data)

      db = Database.new(PetHUD.db_path)
      Exporter.new(db).write_web_data(generated_at: Time.now.utc.iso8601)
      db.close
    end

    def handle(client)
      request = read_request(client)
      return respond(client, 400, "text/plain", "Bad Request") unless request

      method, path, _headers, body = request
      route(client, method, path, request[2], body)
    rescue => e
      warn "server error: #{e.class}: #{e.message}"
      respond(client, 500, "application/json", JSON.generate(error: e.message)) rescue nil
    ensure
      client.close rescue nil
    end

    def route(client, method, path, headers, body)
      uri = URI.parse(path)
      route_path = uri.path

      if method == "POST" && route_path == "/api/import"
        handle_import(client, headers, body)
      elsif method == "GET" && route_path == "/api/data"
        respond(client, 200, MIME[".json"], JSON.generate(current_payload))
      elsif method == "GET"
        serve_static(client, route_path)
      else
        respond(client, 405, "text/plain", "Method Not Allowed")
      end
    end

    # --- import endpoint --------------------------------------------------

    def handle_import(client, headers, body)
      if body.nil? || body.empty?
        return respond(client, 400, MIME[".json"], JSON.generate(error: "empty upload"))
      end

      filename = sanitize_filename(headers["x-filename"] || "dropped.pdf")
      unless filename.downcase.end_with?(".pdf") && body[0, 5] == "%PDF-"
        return respond(client, 415, MIME[".json"], JSON.generate(error: "not a PDF file"))
      end

      result = @import_mutex.synchronize { import_bytes(filename, body) }
      respond(client, 200, MIME[".json"], JSON.generate(result))
    end

    # Persist the bytes to inbox/, import, regenerate data.js, return summary.
    def import_bytes(filename, bytes)
      FileUtils.mkdir_p(PetHUD.inbox_dir)
      dest = File.join(PetHUD.inbox_dir, filename)
      File.binwrite(dest, bytes)

      importer = Importer.new
      res = importer.import(dest, force: true) # force: re-dropping replaces
      Exporter.new(importer.db).write_web_data(generated_at: Time.now.utc.iso8601)
      payload = current_payload(importer.db)
      importer.close

      {
        ok: true,
        status: res.status,
        file: filename,
        patient: res.patient.name,
        date: res.parsed[:meta][:result_date],
        values: res.parsed[:sections].sum { |s| s[:measurements].size },
        data: payload
      }
    end

    def current_payload(db = nil)
      own = db.nil?
      db ||= Database.new(PetHUD.db_path)
      payload = Exporter.new(db).build_payload(generated_at: Time.now.utc.iso8601)
      db.close if own
      payload
    end

    # --- static files -----------------------------------------------------

    def serve_static(client, route_path)
      route_path = "/index.html" if route_path == "/"
      full = File.expand_path(File.join(@web_dir, route_path))
      # Prevent path traversal outside web/.
      unless full.start_with?(@web_dir + File::SEPARATOR) || full == @web_dir
        return respond(client, 403, "text/plain", "Forbidden")
      end
      unless File.file?(full)
        return respond(client, 404, "text/plain", "Not Found")
      end

      type = MIME[File.extname(full)] || "application/octet-stream"
      respond(client, 200, type, File.binread(full))
    end

    # --- HTTP plumbing ----------------------------------------------------

    # Returns [method, path, headers(Hash, lowercased keys), body(String)] or nil.
    def read_request(client)
      request_line = client.gets
      return nil if request_line.nil?

      method, path, = request_line.split(" ")
      return nil unless method && path

      headers = {}
      while (line = client.gets)
        line = line.chomp
        break if line.empty?

        key, _, value = line.partition(":")
        headers[key.strip.downcase] = value.strip
      end

      body = read_body(client, headers)
      [method, path, headers, body]
    end

    def read_body(client, headers)
      length = headers["content-length"].to_i
      return "" if length <= 0
      raise "upload too large (#{length} bytes)" if length > MAX_BODY

      buf = +""
      buf << client.read(length - buf.bytesize) while buf.bytesize < length
      buf.force_encoding(Encoding::BINARY)
    end

    def respond(client, status, content_type, body)
      body = body.to_s
      body = body.dup.force_encoding(Encoding::BINARY)
      reason = { 200 => "OK", 400 => "Bad Request", 403 => "Forbidden",
                 404 => "Not Found", 405 => "Method Not Allowed",
                 415 => "Unsupported Media Type", 500 => "Internal Server Error" }[status] || "OK"
      headers = [
        "HTTP/1.1 #{status} #{reason}",
        "Content-Type: #{content_type}",
        "Content-Length: #{body.bytesize}",
        "Cache-Control: no-store",
        "Connection: close",
        "", ""
      ].join("\r\n")
      client.write(headers)
      client.write(body)
    end

    def sanitize_filename(name)
      base = File.basename(name.to_s.strip)
      base = base.gsub(/[^A-Za-z0-9._-]/, "_")
      base.empty? ? "dropped.pdf" : base
    end
  end
end
