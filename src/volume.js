import coolwarm from "./colormaps/cool-warm-paraview.png";
import plasma from "./colormaps/matplotlib-plasma.png";
import virdis from "./colormaps/matplotlib-virdis.png";
import rainbow from "./colormaps/rainbow.png";
import samselGreen from "./colormaps/samsel-linear-green.png";
import samselYgb from "./colormaps/samsel-linear-ygb-1211g.png";

export const volumes = {
    "Fuel": "7d87jcsh0qodk78/fuel_64x64x64_uint8.raw",
    "Neghip": "zgocya7h33nltu9/neghip_64x64x64_uint8.raw",
    "Hydrogen Atom": "jwbav8s3wmmxd5x/hydrogen_atom_128x128x128_uint8.raw",
    "Boston Teapot": "w4y88hlf2nbduiv/boston_teapot_256x256x178_uint8.raw",
    "Engine": "ld2sqwwd3vaq4zf/engine_256x256x128_uint8.raw",
    "Bonsai": "rdnhdxmxtfxe0sa/bonsai_256x256x256_uint8.raw",
    "Foot": "ic0mik3qv4vqacm/foot_256x256x256_uint8.raw",
    "Skull": "5rfjobn0lvb7tmo/skull_256x256x256_uint8.raw",
    "Aneurysm": "3ykigaiym8uiwbp/aneurism_256x256x256_uint8.raw",
};

export const colormaps = {
    "Cool Warm": coolwarm,
    "Matplotlib Plasma": plasma,
    "Matplotlib Virdis": virdis,
    "Rainbow": rainbow,
    "Samsel Linear Green": samselGreen,
    "Samsel Linear YGB 1211G": samselYgb,
};

export function getVolumeDimensions(file)
{
    var fileRegex = /.*\/(\w+)_(\d+)x(\d+)x(\d+)_(\w+)\.*/;
    var m = file.match(fileRegex);
    return [parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
}

export function getCubeMesh()
{
    var cubeVertices = [
        1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0,
        1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0
    ];
    // Indices are required to render a triangle strip, but ours here are trivial
    var cubeIndices = [];
    for (var i = 0; i < cubeVertices.length; ++i) {
        cubeIndices.push(i);
    }
    return {vertices: cubeVertices, indices: cubeIndices};
}

export async function fetchVolume(file)
{
    var url = "https://www.dl.dropboxusercontent.com/s/" + file + "?dl=1";
    // TODO: could later monitor progress here
    var data = await fetch(url).then((res) => res.arrayBuffer().then(function(arr) {
        return new Uint8Array(arr);
    }));
    var loadingProgressText = document.getElementById("loadingText");

    if (data) {
        loadingProgressText.innerHTML = "Volume Loaded";
    } else {
        loadingProgressText.innerHTML = "Error loading volume";
    }
    return data;
}

export function linearToSRGB(x)
{
    if (x <= 0.0031308) {
        return 12.92 * x;
    }
    return 1.055 * Math.pow(x, 1.0 / 2.4) - 0.055;
}
