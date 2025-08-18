class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.5.3"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.3/supercet-arm64"
  sha256 "f33119a0ba4bb7d10e5de72f5463da2606182a7f569c022fc3accf36b31f39f0"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.3/supercet-arm64"
    sha256 "f33119a0ba4bb7d10e5de72f5463da2606182a7f569c022fc3accf36b31f39f0"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.3/supercet-x64"
    sha256 "20733e5a1a8077c7c583bf196b5f618fdd6ae3069a0c796ef0354b030f000ca0"
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
