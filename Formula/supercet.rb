class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.12"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.12/supercet-arm64"
  sha256 "60a9adf4bea552b04b57df75c9de1b5c9b35a07d400a1df74e023ba6f6081205"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.12/supercet-arm64"
    sha256 "60a9adf4bea552b04b57df75c9de1b5c9b35a07d400a1df74e023ba6f6081205"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.12/supercet-x64"
    sha256 "22eb8919af4e081db80058fde9ea3a1aea0d3428ec2dcaf421db7c284006c3d1"
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
