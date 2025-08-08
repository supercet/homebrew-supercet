class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.20"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.20/supercet-arm64"
  sha256 "f272cfbbf965445126b70e35fb7158459f5b3e6b2e18cb96753f6ccad5b5ec23"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.20/supercet-arm64"
    sha256 "f272cfbbf965445126b70e35fb7158459f5b3e6b2e18cb96753f6ccad5b5ec23"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.20/supercet-x64"
    sha256 "0d34f54ecaabe534d9c4babb337aba96759b12a0ae14a6e3df61b93593ce4cb6"
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
