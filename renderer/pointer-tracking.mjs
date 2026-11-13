/** Use one native clock for desktop gaze, with ordered local preview fallback. */
import {setGazeTarget} from './state.mjs';
import {characterView} from './viewport.mjs';

const localClock=()=>performance.timeOrigin+performance.now();
export function createPointerTracking(state,anchor,clock=localClock){
  let latestAt=-Infinity, nativeAt=-Infinity, nativeSequence=0, nativeSource=false;
  return {
    sample({localX,localY,width,height,sampledAt,viewport,sequence,clock:sourceClock}){
      if(![localX,localY,width,height].every(Number.isFinite)||width<=0||height<=0)return false;
      if(sourceClock==='desktop-monotonic'){
        if(!Number.isSafeInteger(sequence)||sequence<=nativeSequence
          ||!Number.isFinite(sampledAt)||sampledAt<nativeAt)return false;
        nativeSequence=sequence;nativeAt=sampledAt;
        const localWasNewer=!nativeSource&&latestAt!==-Infinity;
        nativeSource=true;
        // The initial IPC packet may have waited behind a local pointer event.
        // Its ACK still releases the host's next fresh sample. Subsequent gaze
        // comes only from that native stream, never a different process origin.
        if(localWasNewer)return false;
      }else{
        if(sourceClock!==undefined||nativeSource)return false;
        const at=Number.isFinite(sampledAt)?sampledAt:clock();
        if(!Number.isFinite(at)||at<latestAt)return false;
        latestAt=at;
      }
      // Large pets extend beyond the native window; use their virtual origin.
      const {scale,x:ox,y:oy}=characterView(width,height,viewport);
      setGazeTarget(state,(localX-ox-anchor.gazeX*scale)/(230*scale),(localY-oy-anchor.gazeY*scale)/(240*scale));
      return true;
    },
  };
}
