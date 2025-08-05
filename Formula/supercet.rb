class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.15"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.15/supercet-arm64"
  sha256 "2f3475f6009d904adbb474244b52a986e9b56893fd4cd684973d7ed66d17eba0"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.15/supercet-arm64"
    sha256 "2f3475f6009d904adbb474244b52a986e9b56893fd4cd684973d7ed66d17eba0"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.15/supercet-x64"
    sha256 "6ed723dae2d2f5972491af1e4da8e76ac11f58e62206ccaa857c61745f58dcfe"
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
