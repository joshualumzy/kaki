import React from 'react';
import {Composition} from 'remotion';
import './fonts';
import {FilmV10} from './film/FilmV10';
import {DURATION_FRAMES, FPS, HEIGHT, WIDTH} from './film/timeline';

export const RemotionRoot: React.FC = () => (
  <Composition id="FilmV10" component={FilmV10} durationInFrames={DURATION_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT}/>
);
