class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.4.0"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.4.0/supercet-arm64"
  sha256 "c7f23b6a81e5acff2876dbe7f3c51d8b895251d8b5d6a30b0b7ed450abad3d56"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.4.0/supercet-arm64"
    sha256 "c7f23b6a81e5acff2876dbe7f3c51d8b895251d8b5d6a30b0b7ed450abad3d56"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.4.0/supercet-x64"
    sha256 "184ee55aa69ed4981e192cd68c37425d8586de171f2fe84579416c04c84208fd"
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
