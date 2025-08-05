class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.9/supercet-arm64"
  sha256 "1844f3ee13e2f3edda391a6057631fccf9d67595ea28428ff2fe22de22067a05"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.9/supercet-arm64"
    sha256 "1844f3ee13e2f3edda391a6057631fccf9d67595ea28428ff2fe22de22067a05"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.9/supercet-x64"
    sha256 "3ea10fa7c2efb9213b3be9e42623d649ed21c996637db4fb380ad7abf47c093f"
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
