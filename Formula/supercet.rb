class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.6.1"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.1/supercet-arm64"
  sha256 "6926393eb3875ba9e4f354418f1cf27456e0ac8aeade967db6555e11a4911977"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.1/supercet-arm64"
    sha256 "6926393eb3875ba9e4f354418f1cf27456e0ac8aeade967db6555e11a4911977"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.1/supercet-x64"
    sha256 "7cb732c270269d9c691578bd054ee6a7c40df701e37706180a13e974d6a0b78b"
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
