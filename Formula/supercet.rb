class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.5.5"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.5/supercet-arm64"
  sha256 "144d9461716286c117d4d424db682bb38c5d7119d8b545e938ba87a5f71b02c8"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.5/supercet-arm64"
    sha256 "144d9461716286c117d4d424db682bb38c5d7119d8b545e938ba87a5f71b02c8"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.5.5/supercet-x64"
    sha256 "468bf1fc907d548fba0f575e66957398de8eb08c403914373edf50287a0a7c96"
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
