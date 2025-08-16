class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.3.10"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.10/supercet-arm64"
  sha256 "9b97e7737ce3bf13d0f4ad5a06e72c410ec325b279ea52abdf1a602d3a98abde"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.10/supercet-arm64"
    sha256 "9b97e7737ce3bf13d0f4ad5a06e72c410ec325b279ea52abdf1a602d3a98abde"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.10/supercet-x64"
    sha256 "c067c29fa3f111e5870b808f2b92c1fd6bc4207b07f6dc597f143ac8f9536410"
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
