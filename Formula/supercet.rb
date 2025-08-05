class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.14"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.14/supercet-arm64"
  sha256 "b44afcdac607fd5d9babae9d62e6246dc2c412c8871a2cc02f0508d3305e7372"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.14/supercet-arm64"
    sha256 "b44afcdac607fd5d9babae9d62e6246dc2c412c8871a2cc02f0508d3305e7372"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.14/supercet-x64"
    sha256 "c5f6ec5c0a190e77fadf04a7ee1d60e7ed4e581489f6da35c3d7d215960373f5"
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
