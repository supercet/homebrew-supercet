class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.5.1"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.1/supercet-arm64"
  sha256 "c88dc99618f787896b3921bcb1608cf4714510ba50b74856f01f7079be056913"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.1/supercet-arm64"
    sha256 "c88dc99618f787896b3921bcb1608cf4714510ba50b74856f01f7079be056913"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.1/supercet-x64"
    sha256 "e59149b4e0bd6dd201932254a52b6ca7efffa1cb804c03769826b12aa8ae7331"
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
