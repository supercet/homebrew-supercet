class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.5.2"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.2/supercet-arm64"
  sha256 "8977e9392391ca607a618a2650cb2088c0c913d22fcf9899e656123b0dfad8ef"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.2/supercet-arm64"
    sha256 "8977e9392391ca607a618a2650cb2088c0c913d22fcf9899e656123b0dfad8ef"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.2/supercet-x64"
    sha256 "efce68e3756acf43f2819c57725f0292f4772c29861d02e4a2f98de1927dccab"
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
