class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.18"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.18/supercet-arm64"
  sha256 "965a28eb970ec5afebf4dfd6c38c6313574c51c3a0aa162ea85a87ffe952668a"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.18/supercet-arm64"
    sha256 "965a28eb970ec5afebf4dfd6c38c6313574c51c3a0aa162ea85a87ffe952668a"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.18/supercet-x64"
    sha256 "c472c0793cccf7ac0fb20a622a3384e4f8d46fd66b3557bc830133939f818775"
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
