class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.3.7"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.7/supercet-arm64"
  sha256 "e2d593c2ea558c59226ea92472f9e8dddd6fedcd4997b70d28d638c98c099202"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.7/supercet-arm64"
    sha256 "e2d593c2ea558c59226ea92472f9e8dddd6fedcd4997b70d28d638c98c099202"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.7/supercet-x64"
    sha256 "5dbf2aea30073b9a28dfea60588609a2166bf11574bb869322ae9bc2755e96be"
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
