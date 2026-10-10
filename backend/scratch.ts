async function teset() {
  new Promise((resolve) => {
    setTimeout(() => {
      console.log("ísso é foo");
      resolve(true);
    }, 200);
  }).then(() => {
    console.log("isso é bar");
  });
}
await teset();
