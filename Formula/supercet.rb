class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.3.6"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.6/supercet-arm64"
  sha256 "8f2f9be968cdc041f72ffc93dcc1bbbdf8e702ac4290e2e78fe09826efbb9ef5"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.6/supercet-arm64"
    sha256 "8f2f9be968cdc041f72ffc93dcc1bbbdf8e702ac4290e2e78fe09826efbb9ef5"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.3.6/supercet-x64"
    sha256 "a1d076ee2ecd0219a9fa7b33a505eb9c4d10e643e89a1acf85bcdeb92f530dbe"
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
