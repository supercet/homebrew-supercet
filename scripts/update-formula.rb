#!/usr/bin/env ruby
require 'json'
require 'open-uri'
require 'digest'

PACKAGE_JSON = 'package.json'
FORMULA      = 'Formula/supercet.rb'

unless File.exist?(PACKAGE_JSON)
  abort "Error: #{PACKAGE_JSON} not found."
end

version = JSON.parse(File.read(PACKAGE_JSON))['version']
puts "→ Detected version: #{version}"

base_url = "https://github.com/supercet/homebrew-supercet/releases/download/v#{version}"
urls = {
  arm:  "#{base_url}/supercet-arm64",
  x64:  "#{base_url}/supercet-x64"
}

puts "→ Fetching ARM binary…"
arm_data = URI.open(urls[:arm]) { |f| f.read }
puts "→ Fetching x64 binary…"
x64_data = URI.open(urls[:x64]) { |f| f.read }

arm_sha = Digest::SHA256.hexdigest(arm_data)
x64_sha = Digest::SHA256.hexdigest(x64_data)

puts "→ ARM SHA256: #{arm_sha}"
puts "→ x64 SHA256: #{x64_sha}"

unless File.exist?(FORMULA)
  abort "Error: #{FORMULA} not found."
end


formula = File.read(FORMULA)

# 1) Update both arm64 and x64 URLs
formula.gsub!(
  %r{url\s+"https://github\.com/supercet/homebrew-supercet/releases/download/v[^/]+/supercet-arm64"},
  "url \"#{urls[:arm]}\""
)
formula.gsub!(
  %r{url\s+"https://github\.com/supercet/homebrew-supercet/releases/download/v[^/]+/supercet-x64"},
  "url \"#{urls[:x64]}\""
)

# 2) Replace the three sha256 lines: first two → ARM, third → x64
count = 0
formula.gsub!(/sha256\s+"[a-f0-9]+"/) do
  count += 1
  if count <= 2
    "sha256 \"#{arm_sha}\""
  else
    "sha256 \"#{x64_sha}\""
  end
end

# Write it back
File.write(FORMULA, formula)
puts "✅ Updated #{FORMULA} to v#{version} with new checksums."