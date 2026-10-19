import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { CaptionStyleSchema, durationInFrames, type CompositionInput } from '@clipforge/shared';
import { ShortVideo, type ShortVideoProps } from './compositions/ShortVideo.js';

export const COMPOSITION_ID = 'ShortVideo';

const defaultProps: ShortVideoProps = {
  timeline: {
    clips: [],
    captions: [
      { id: '00000000-0000-4000-8000-000000000001', startMs: 0, endMs: 2000, text: 'ClipForge AI', timingSource: 'manual' },
    ],
    captionStyle: CaptionStyleSchema.parse({}),
    output: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
    backgroundColor: '#0b0b10',
  },
  assets: {},
};

export const calculateShortVideoMetadata: CalculateMetadataFunction<ShortVideoProps> = ({ props }) => {
  const { output } = props.timeline;
  return {
    durationInFrames: durationInFrames(props.timeline, output.fps),
    fps: output.fps,
    width: output.width,
    height: output.height,
  };
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={ShortVideo as React.FC<CompositionInput & Record<string, unknown>>}
    defaultProps={defaultProps as CompositionInput & Record<string, unknown>}
    calculateMetadata={calculateShortVideoMetadata as unknown as CalculateMetadataFunction<CompositionInput & Record<string, unknown>>}
    durationInFrames={60}
    fps={30}
    width={1080}
    height={1920}
  />
);
