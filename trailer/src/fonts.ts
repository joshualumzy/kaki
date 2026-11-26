import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';
// Local variable files only: renders never contact Google Fonts or Vercel.
loadFont({family:'Geist',url:staticFile('fonts/Geist-Variable.woff2'),weight:'100 900',format:'woff2'});
loadFont({family:'Geist Mono',url:staticFile('fonts/GeistMono-Variable.woff2'),weight:'100 900',format:'woff2'});
