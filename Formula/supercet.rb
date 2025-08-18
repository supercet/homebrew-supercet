class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.5.4"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.4/supercet-arm64"
  sha256 "c901da215e4afb0d210bebd96f0d787d2aa4ba3ad9f41436594b2f81174df394"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.4/supercet-arm64"
    sha256 "c901da215e4afb0d210bebd96f0d787d2aa4ba3ad9f41436594b2f81174df394"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.4/supercet-x64"
    sha256 "89362a6da0a6ab88c96ddfa50607327d07dfda07a49641effe7d7042db722c2f"
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
