class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.59.2"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.59.2/supercet-arm64"
  sha256 "6b6f5582a76ee5eabb1aea8b656b1dd6fe35dd7440d0b4b8cc1517f2dfffcbbd"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.59.2/supercet-arm64"
    sha256 "6b6f5582a76ee5eabb1aea8b656b1dd6fe35dd7440d0b4b8cc1517f2dfffcbbd"
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
