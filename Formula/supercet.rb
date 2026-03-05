class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.9.0"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.9.0/supercet-arm64"
  sha256 "a73bdf3f81cccbc701577a4568bf4605fd3f73597123aa3c96972f5f16a0da79"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.9.0/supercet-arm64"
    sha256 "a73bdf3f81cccbc701577a4568bf4605fd3f73597123aa3c96972f5f16a0da79"
  end

  # on_intel do
  #   url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.2/supercet-x64"
  #   
  # end

  def install
    # Install the pre-compiled binary
    bin.install "supercet-#{Hardware::CPU.arm? ? "arm64" : "x64"}" => "supercet"
    chmod 0755, bin/"supercet"
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  test do
    # Test that the binary exists and is executable
    assert_predicate bin/"supercet", :exist?
    assert_predicate bin/"supercet", :executable?
    
    # Test that the command runs (even if it fails, it should not crash)
    system "#{bin}/supercet", "--help"
  end
end
