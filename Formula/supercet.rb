class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.10/supercet-arm64"
  sha256 "d56d1471b918e7c5bb69c5d5bed996fb7ea22b8aa788e151a00ef592d83f59ba"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.10/supercet-arm64"
    sha256 "d56d1471b918e7c5bb69c5d5bed996fb7ea22b8aa788e151a00ef592d83f59ba"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.10/supercet-x64"
    sha256 "dafc7d9396d009db617f3984e33ec2dd7ec7da1dc2582c156fa8d7c485e66c6f"
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
