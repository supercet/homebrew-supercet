class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.16"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.16/supercet-arm64"
  sha256 "6c7e51a10c1b92b68f486ab9129a21ce62dba093dca8ba6dcc735ace7d6f3ef2"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.16/supercet-arm64"
    sha256 "6c7e51a10c1b92b68f486ab9129a21ce62dba093dca8ba6dcc735ace7d6f3ef2"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.16/supercet-x64"
    sha256 "23f963ce66484d9660af6578d2837f6622d424b4ffbfd08f176ce497550344f8"
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
