class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.11"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.11/supercet-arm64"
  sha256 "89d2955bc093ed46babda6452d407d7714f5ad53694f7b0288bbf5f34bcd8169"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.11/supercet-arm64"
    sha256 "89d2955bc093ed46babda6452d407d7714f5ad53694f7b0288bbf5f34bcd8169"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.11/supercet-x64"
    sha256 "55e4a6d63b3b20030faab27abeeb638fc4b08c7cf3fda668e7b674540a4d3900"
  end

  def install
    # Install the pre-compiled binary
    bin.install "supercet-#{Hardware::CPU.arm? ? "arm64" : "x64"}" => "supercet"
    chmod 0755, bin/"supercet"
  end

  test do
    # Test that the binary exists and is executable
    assert_predicate bin/"supercet", :exist?
    assert_predicate bin/"supercet", :executable?
    
    # Test that the command runs (even if it fails, it should not crash)
    system "#{bin}/supercet", "--help"
  end
end
