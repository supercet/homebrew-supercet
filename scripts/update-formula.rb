#!/usr/bin/env ruby

require 'net/http'
require 'json'

def calculate_sha256(url, version)
  puts "Downloading and calculating SHA256 for: #{url}"
  
  # Use curl to download and pipe directly to shasum
  # This avoids storing the full binary in memory
  command = "curl -L -s '#{url}' | shasum -a 256"
  
  result = `#{command}`
  
  if $?.success?
    # Extract just the hash (remove the trailing dash and newline)
    sha256 = result.strip.split(' ').first
    puts "Successfully calculated SHA256: #{sha256}"
    return sha256
  else
    puts "Error: Failed to download or calculate SHA256 for #{url}"
    puts "Command failed with exit code: #{$?.exitstatus}"
    puts "Make sure the release v#{version} exists on GitHub with the binary files"
    puts "Try visiting the URL manually to verify it exists: #{url}"
    exit 1
  end
end

# Get the latest version from package.json
package_json = JSON.parse(File.read('package.json'))
version = package_json['version']

puts "Updating formula for version #{version}"

# URLs for the pre-compiled binaries
arm64_url = "https://github.com/supercet/homebrew-supercet/releases/download/v#{version}/supercet-arm64"
x64_url = "https://github.com/supercet/homebrew-supercet/releases/download/v#{version}/supercet-x64"

puts "Calculating SHA256 for ARM64 binary..."
arm64_sha256 = calculate_sha256(arm64_url, version)

puts "Calculating SHA256 for x64 binary..."
x64_sha256 = calculate_sha256(x64_url, version)

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
