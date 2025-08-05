class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.1.13"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.13/supercet-arm64"
  sha256 "51a2740c1f15110af4c5b8f1ef4db4c5c5986379f1209918f9bbb01777c850b6"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.13/supercet-arm64"
    sha256 "51a2740c1f15110af4c5b8f1ef4db4c5c5986379f1209918f9bbb01777c850b6"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.1.13/supercet-x64"
    sha256 "6154316495c7b1682aacb57d578e473fd3faa9420dcfab2d37daed4fee2174bd"
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
