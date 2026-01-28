class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.6.2"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.2/supercet-arm64"
  sha256 "175ad6ad804cb1dd8cd5c47475d146db7226acec985fef35057e9c1872c81827"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.2/supercet-arm64"
    sha256 "175ad6ad804cb1dd8cd5c47475d146db7226acec985fef35057e9c1872c81827"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.6.2/supercet-x64"
    sha256 "515a22c1bfe1d7b103100b07ac18ae87e141ad8a82a42d10fa64f6880c02d5d8"
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
