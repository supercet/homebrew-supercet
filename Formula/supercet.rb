class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.5.0"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.0/supercet-arm64"
  sha256 "f38f74161b0b454776fedbec7d50bdf176465689dc723b2772b2c8d805a58800"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.0/supercet-arm64"
    sha256 "f38f74161b0b454776fedbec7d50bdf176465689dc723b2772b2c8d805a58800"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.0/supercet-x64"
    sha256 "7958c658655c548c8484f0e7300bda89428e9657c91f55f62044c9bb469be880"
  end

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
