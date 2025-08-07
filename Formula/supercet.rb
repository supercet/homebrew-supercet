class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.19"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.19/supercet-arm64"
  sha256 "cc7559d523a1d5f4f812436eff564c3148cfc58b30579a69b0cf52c7ff3208d6"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.19/supercet-arm64"
    sha256 "cc7559d523a1d5f4f812436eff564c3148cfc58b30579a69b0cf52c7ff3208d6"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.19/supercet-x64"
    sha256 "2f44d5a4266c19717f56df6c3691748f634c3945fb5bab1187fe8d58e7f0a5dc"
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
