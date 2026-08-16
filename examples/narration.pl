# narration.pl — the words, written by Perl, inside WebAssembly.
#
# zeroperl runs this in the sandbox; whatever lands on stdout is what
# Kokoro will say. The mother of Perl finally has her child do the
# writing, which is what mothers always hoped Perl would grow up to do.
use strict;
use warnings;

my $frames = 150;
my $zoom   = 0.933**-$frames;

printf "The pearl remembers the sand. ";
printf "This time the picture comes from the graphics processor: "
     . "%d frames, a zoom of %d thousand, dispatched through WebGPU. ",
  $frames, int( $zoom / 1000 );
print "Perl wrote this sentence inside the sandbox. "
    . "Kokoro is speaking it from the sandbox next door. "
    . "The glue, as always, is hot.\n";
