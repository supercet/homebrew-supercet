#!/usr/bin/env ruby

require 'net/http'
require 'json'

# Get the latest version from package.json
package_json = JSON.parse(File.read('package.json'))
version = package_json['version']

puts "Updating formula for version #{version}"

# URLs for the pre-compiled binaries
arm64_url = "https://github.com/supercet/homebrew-supercet/releases/download/v#{version}/supercet-arm64"
x64_url = "https://github.com/supercet/homebrew-supercet/releases/download/v#{version}/supercet-x64"

puts "Calculating SHA256 for ARM64 binary..."
arm64_sha256 = calculate_sha256(arm64_url)

puts "Calculating SHA256 for x64 binary..."
x64_sha256 = calculate_sha256(x64_url)

# Update the formula
formula_path = 'Formula/supercet.rb'
formula_content = File.read(formula_path)

# Update version and SHA256 values
updated_content = formula_content.gsub(
  /url "https:\/\/github\.com\/supercet\/homebrew-supercet\/releases\/download\/v[^"]+"/,
  "url \"https://github.com/supercet/homebrew-supercet/releases/download/v#{version}/supercet-arm64\""
).gsub(
  /sha256 "PLACEHOLDER_SHA256_ARM64"/,
  "sha256 \"#{arm64_sha256}\""
).gsub(
  /sha256 "PLACEHOLDER_SHA256_X64"/,
  "sha256 \"#{x64_sha256}\""
)

File.write(formula_path, updated_content)
puts "Updated #{formula_path} with version #{version}"
puts "ARM64 SHA256: #{arm64_sha256}"
puts "x64 SHA256: #{x64_sha256}"

def calculate_sha256(url)
  uri = URI(url)
  response = Net::HTTP.get_response(uri)
  
  if response.code == '200'
    require 'digest'
    Digest::SHA256.hexdigest(response.body)
  else
    puts "Error: Could not download #{url} (HTTP #{response.code})"
    puts "Make sure the release v#{version} exists on GitHub with the binary files"
    exit 1
  end
end 