class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.6.9"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.9/supercet-arm64"
  sha256 "cc9001d05adaa4b5a4bce3d483ee32f239bb0cc24b8346ff04d8f299d8bf6eb3"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.9/supercet-arm64"
    sha256 "cc9001d05adaa4b5a4bce3d483ee32f239bb0cc24b8346ff04d8f299d8bf6eb3"
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
