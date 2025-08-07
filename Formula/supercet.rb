class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.17"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.17/supercet-arm64"
  sha256 "ba53f1fcb7dd027cc20065f65d6d5142395053e6329f30cbd6051583cf87bdc5"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.17/supercet-arm64"
    sha256 "ba53f1fcb7dd027cc20065f65d6d5142395053e6329f30cbd6051583cf87bdc5"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.17/supercet-x64"
    sha256 "781d11fc83a9fc3b5ff541dccc4aa1e1e4e60726e9105b7be9a0d850ba0cd7dd"
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
